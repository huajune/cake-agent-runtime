# WeCom 消息处理数据流

> 本文列出消息处理时读写的数据。收发架构、恢复时序和按段续投递的版本边界见[企微消息服务架构](../architecture/message-service-architecture.md#主聊收发时序)。
>
> 关键实现：[message](../../src/channels/wecom/message)、[agent](../../src/agent)、[memory](../../src/memory)、[monitoring](../../src/biz/monitoring)。

## 1. 数据落点

| 位置                                  | 用途                                               | 当前标识                                             |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Supabase `chat_messages`              | 对话底仓；短期窗口从这里取最近 N 条再套滚动 7 天窗 | `chatId`                                             |
| Supabase `message_processing_records` | 消息处理流水与 Agent 观测                          | `messageId` / `batchId`                              |
| Supabase `agent_reply_inputs`、`agent_reply_turns` | 主聊执行回合的输入成员、执行权与投递结局 | 渠道作用域内的 `message_id`、`logical_turn_id` |
| Supabase `agent_action_records`、`agent_action_evidence` | 分段发送动作与原派发凭证 | `action_id`、`request_id`、派发尝试 ID |
| Redis pending list                    | debounce 期间和 Agent 运行期间到达的待处理消息     | `wecom:message:pending:{chatId}`                     |
| Redis last-message-at                 | 静默窗口判定                                       | `wecom:message:last-message-at:{chatId}`             |
| Redis trace hash                      | 当前请求的增量 timings、Agent 请求与结果           | `wecom:message:trace:{messageId}:v2`                 |
| Redis short-term                      | 消息热缓存、facts、工作台、阶段指针                | `memory:short_term:chat:*` / `factsv2:*` / `stage:*` |
| Supabase + Redis long-term            | 候选人 × bot 关系档与 2 小时读缓存                 | DB `agent_long_term_memories` / `long-term:*`        |
| Bull `message-merge`                  | 静默窗口 delayed job                               | 每条入站消息一个 job                                 |

Redis key 的完整字段、TTL 和所有者见 [Redis 数据模型](../db/redis-schema.md)。

## 2. 主时序

```text
WeCom callback
  → intake 过滤、去重、写 user 历史、创建单消息流水
  → pending list + delayed job
  → quiet-window worker 取得 chat 处理锁
  → 读取 pending 快照，执行档先登记或查回本轮输入归属
  → 进入生成时创建 batch trace，合并准备耗时，异步回收源流水
  → AgentRunner.runInboundTurn
      → Input Guard
      → Preparation（两层记忆召回、共享裁决、Prompt sections、tools）
      → Generator + Tool Guard
      → Output Guard / Reply Repair
      → TurnOutcome
  → 未固定输入回合时，符合条件可合入新输入并重放，最多 3 次
  → 按最终 outcome 投递回复、沉默或转人工，执行该结局要求的业务动作
  → 用实际投递结果结算 TurnFinalizer
  → 按本轮接纳的消息 ID 确认输入，等待 turn-end 落盘，释放处理锁
```

### 2.1 Intake

普通入站由 `AcceptInboundMessageService` 准备消息，再由渠道分派。

1. 过滤不支持的事件并做 Redis 去重。
2. 创建请求 trace 和 `processing` 流水。
3. 有图片时补齐载荷。
4. 异步写入 `chat_messages` 的 user 记录。
5. 开启聚合时，将消息加入 pending list 并安排 delayed job。关闭聚合时走单消息编排。

普通入站回调快速返回接收成功。纳管发送回执先验证来源、匹配原请求并保存凭证，再应答。

### 2.2 静默聚合与处理锁

`MessageProcessor` 到点后先取得 chat 级租约锁，再确认静默窗口已满。满足条件时，
`SimpleMergeService` 原子取得当前 pending 快照；主编排把多条消息合成一个 batch，合并源 trace 的准备耗时，并删除只用于 intake 的源 `processing` 行。

同一 `chatId` 的聚合任务由租约锁串行，应用层并发槽限制同时执行的任务数。读取快照保留原消息，处理结束后按本轮消息 ID 确认，后续任务接手剩余输入。

### 2.3 Agent 回合

`ReplyWorkflowService` 调用 `AgentRunnerService.runInboundTurn()`：

1. Input Guard 可在生成前短路高风险输入；
2. `PreparationService.prepare()` 按“输入归一化 → 集中外部快照 → 共享裁决 → typed sections → 工具运行时”组装 `WorkingMemory`；
3. Generator 多步调用模型和工具，工具动作先过 Tool Guard；
4. Output Guard 审查候选回复；需要时只进入一次受控 repair 并二审；
5. runner 返回渠道无关的 `TurnOutcome`，同时携带本次版本的 `runTurnEnd` 闭包。

`runTurnEnd` 在这里不会立即执行。渠道把它包装成 `TurnFinalizer`，等最终投递结局确定后再结算。

### 2.4 有界 replay

已登记的主聊执行回合固定输入成员，生成期间后到的消息留给下一轮。未建立持久回合时，主编排按以下条件处理新输入。

- 没有新消息时采用当前 outcome。
- 有新消息且允许重放时，丢弃当前 `TurnFinalizer`，合入新消息后重新运行 Agent。
- 通常遇到非 reply 结局、待提交的业务动作或阻止重放的工具结果时，采用当前版本，新输入留给下一轮。
- 最多重放 3 次，避免持续输入让一个 worker 永不结束。

工具的重放约束来自工具契约和动作凭证。预约、邀请等动作已成功、仍在途或结果未知时，保留当前版本。若工具在真正派发前因新输入中止，且此前没有阻止重放的动作凭证，才可吸收新消息。[工具重放判定](../../src/agent/generator/tool-call-analysis.ts) · [回合结果判定](../../src/agent/runner/turn-outcome.ts)

### 2.5 Outcome、副作用与投递

replay 定局后，`TurnOutcomeInterventionService` 才提交最终 outcome 声明的暂停托管、告警等副作用，避免被丢弃的中间版本误触发外部动作。

随后按 outcome 分流：

- `reply`：分段投递候选人可见回复；
- `skipped`：不发送文本；
- `handoff`：按入站风险、出站守卫或工具来源携带的既有意图执行人工兜底，不把受控文本当正常回复投递。

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
