# WeCom 消息处理数据流

> 以当前生产代码为准，描述企微入站消息从接收、聚合、Agent 回合、重放到投递和记忆收尾的完整链路。
>
> 关键实现：[message](../../src/channels/wecom/message)、[agent](../../src/agent)、[memory](../../src/memory)、[monitoring](../../src/biz/monitoring)。

## 1. 数据落点

| 位置                                  | 用途                                           | 当前标识                                             |
| ------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Supabase `chat_messages`              | 对话底仓；短期窗口从这里回看最近 7 天          | `chatId`                                             |
| Supabase `message_processing_records` | 消息处理流水与 Agent 观测                      | `messageId` / `batchId`                              |
| Redis pending list                    | debounce 期间和 Agent 运行期间到达的待处理消息 | `wecom:message:pending:{chatId}`                     |
| Redis last-message-at                 | 静默窗口判定                                   | `wecom:message:last-message-at:{chatId}`             |
| Redis trace hash                      | 当前请求的增量 timings、Agent 请求与结果       | `wecom:message:trace:{messageId}:v2`                 |
| Redis short-term                      | 消息热缓存、facts、工作台、阶段指针            | `memory:short_term:chat:*` / `factsv2:*` / `stage:*` |
| Supabase + Redis long-term            | 候选人 × bot 关系档与 2 小时读缓存             | DB `agent_long_term_memories` / `long-term:*`        |
| Bull `message-merge`                  | 静默窗口 delayed job                           | 每条入站消息一个 job                                 |

Redis key 的完整字段、TTL 和所有者见 [Redis 数据模型](../db/redis-schema.md)。

## 2. 主时序

```text
WeCom callback
  → intake 过滤、去重、写 user 历史、创建单消息流水
  → pending list + delayed job
  → quiet-window worker 取得 chat 处理锁
  → 合并 pending，创建 batch trace，回收源流水
  → AgentRunner.runInboundTurn
      → Input Guard
      → Preparation（两层记忆召回、共享裁决、Prompt sections、tools）
      → Generator + Tool Guard
      → Output Guard / Reply Repair
      → TurnOutcome
  → 最多 3 次有界 replay
  → commit 最终 outcome 的副作用
  → 投递或按 outcome 沉默/转人工
  → TurnFinalizer.settle({ delivered })
  → 等待 turn-end 落盘后释放处理锁
```

### 2.1 Intake

`AcceptInboundMessageService` 对每条回调独立执行：

1. 过滤不支持的事件并做 Redis 去重；
2. 创建请求 trace 和 `processing` 流水；
3. 异步写入 `chat_messages` 的 user 记录；
4. 必要时准备图片描述；
5. 把消息加入 pending list，并为本条消息创建 delayed job。

入口尽快返回 200；真正生成回复由 worker 完成。

### 2.2 静默聚合与处理锁

`MessageProcessor` 到点后先取得 chat 级租约锁，再确认静默窗口已满。满足条件时，
`SimpleMergeService` 原子取得当前 pending 快照；主编排把多条消息合成一个 batch，合并源 trace 的准备耗时，并删除只用于 intake 的源 `processing` 行。

同一 `chatId` 由租约锁串行；应用层并发槽限制真正执行的 worker 数。处理结束前会补建 follow-up job，承接本轮没有消费的后续消息。

### 2.3 Agent 回合

`ReplyWorkflowService` 调用 `AgentRunnerService.runInboundTurn()`：

1. Input Guard 可在生成前短路高风险输入；
2. `PreparationService.prepare()` 按“输入归一化 → 集中外部快照 → 共享裁决 → typed sections → 工具运行时”组装 `WorkingMemory`；
3. Generator 多步调用模型和工具，工具动作先过 Tool Guard；
4. Output Guard 审查候选回复；需要时只进入一次受控 repair 并二审；
5. runner 返回渠道无关的 `TurnOutcome`，同时携带本次版本的 `runTurnEnd` 闭包。

`runTurnEnd` 在这里不会立即执行。渠道把它包装成 `TurnFinalizer`，等最终投递结局确定后再结算。

### 2.4 有界 replay

每次 Agent 生成后，主编排检查生成期间新到达的 pending 消息：

- 没有新消息：采用当前 outcome；
- 有新消息且当前 outcome 可重放：丢弃当前 `TurnFinalizer`，合入新消息后重新运行 Agent；
- outcome 已是非 reply 终态、含待提交副作用，或成功调用了 replay-blocking 工具：采用当前 outcome，新消息留给 follow-up；
- 最多重放 3 次，避免持续输入让一个 worker 永不结束。

当前成功提交后阻断 replay 的工具只有：

- `invite_to_group`
- `duliday_interview_booking`

列表及“成功提交”的判定以 [tool-call-analysis.ts](../../src/agent/generator/tool-call-analysis.ts) 的 `REPLAY_BLOCKING_TOOLS` / `blocksReplay()` 为准。若不可逆工具在提交前通过 `hasNewerUserInput` 发现了新消息，它会以 `staleInput` 短路旧回合；这种结果允许继续吸收 pending 并 replay。

### 2.5 Outcome、副作用与投递

replay 定局后，`TurnOutcomeInterventionService` 才提交最终 outcome 声明的暂停托管、告警等副作用，避免被丢弃的中间版本误触发外部动作。

随后按 outcome 分流：

- `reply`：分段投递候选人可见回复；
- `skipped`：不发送文本；
- `guardrail_blocked` / `handoff`：按终态执行人工兜底，不把受控文本当正常回复投递。

流水记录最终状态、token、工具调用和耗时；assistant 对话历史主要由发送后的 `isSelf=true` 企微回调写入，而不是主投递函数直接补写。

### 2.6 TurnFinalizer 与记忆收尾

`TurnFinalizer` 收口三条不变量：

- replay 丢弃的版本不执行 turn-end；
- `delivered=false` 时仍吸收用户事实，但不投影未送达的助手文本；
- 处理锁释放前 `await whenSettled()`，避免下一个 job 与本轮记忆写入并发。

turn-end 更新短期 facts、工作台与阶段相关投影，并刷新同一 chat 的 delayed consolidation job。闲置达到 3 天后，consolidation 将本段咨询沉淀为长期 profile、job intent 和一条 episodic 摘要。

## 3. 容易混淆的边界

### `messageId` 与 `batchId`

单条 intake 流水用入站 `messageId`；聚合后的主 trace 用 `batchId`。被合并的源流水必须回收，否则会留下“处理中”孤儿。

### 两层记忆不是两个 Redis key

“两层”指作用域：short-term 与 long-term。short-term 内含 7 天消息窗口和 3 天会话状态；`turnHints` 是本轮 sidecar，episode 是沉淀计算边界，都不是独立存储层。

### `currentUserMessage`

它取 normalized messages 末尾连续 user 块的合并文本，不等价于机械取最后一条。实现见 [conversation-normalizer.ts](../../src/agent/generator/preparation/conversation-normalizer.ts)。

### `final-check` 与 `critical-turn-guard`

场景显式注册 `final-check` 与 `critical-turn-guard` 两个 section，但它们共用唯一
`FINAL_CHECK_RULES` 规则源。后者只在本轮规则命中时产出 block。

## 4. 关键代码

| 职责               | 文件                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Intake             | [accept-inbound-message.service.ts](../../src/channels/wecom/message/application/accept-inbound-message.service.ts)         |
| pending 与静默窗口 | [simple-merge.service.ts](../../src/channels/wecom/message/runtime/simple-merge.service.ts)                                 |
| Worker             | [message.processor.ts](../../src/channels/wecom/message/runtime/message.processor.ts)                                       |
| 主编排与 replay    | [reply-workflow.service.ts](../../src/channels/wecom/message/application/reply-workflow.service.ts)                         |
| Agent outcome      | [agent-runner.service.ts](../../src/agent/runner/agent-runner.service.ts)                                                   |
| Replay 判定        | [turn-outcome.ts](../../src/agent/runner/turn-outcome.ts)                                                                   |
| Turn-end 收口      | [turn-finalizer.ts](../../src/agent/runner/turn-finalizer.ts)                                                               |
| 请求观测           | [wecom-message-observability.service.ts](../../src/channels/wecom/message/telemetry/wecom-message-observability.service.ts) |
| 记忆生命周期       | [lifecycle.service.ts](../../src/memory/lifecycle.service.ts)                                                               |
