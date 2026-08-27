# 企微消息服务架构

**最后更新**：2026-08-26

本文描述企业微信消息从回调接入到回复投递的渠道编排。Agent 内部的 Preparation、Generator、Guardrail 与 Outcome 见 [Agent 运行时架构](./agent-runtime-architecture.md)；逐存储时序见 [WeCom 消息处理数据流](../workflows/wecom-message-dataflow.md)。

## 1. 分层与职责

```text
Stride Callback
  → Ingress：回调 DTO 归一化，立即 ACK
  → Application：过滤、去重、历史/图片准备、回复主编排
  → Runtime：debounce、Bull worker、chat 租约锁、动态配置、并发槽
  → AgentRunner.runTurn：Input / Prompt / Tool / Output 四个作用位
  → Delivery：分段、拟人延迟、渠道发送
  → Telemetry：trace、流水、token、工具与投递状态
```

| 层          | 核心实现       | 责任边界                                |
| ----------- | -------------- | --------------------------------------- |
| Ingress     | `ingress/`     | 回调适配与快速 200，不做长耗时业务      |
| Application | `application/` | 消息准入、主回合、失败收敛、图片兼容    |
| Runtime     | `runtime/`     | pending、静默窗口、worker、锁、配置快照 |
| Delivery    | `delivery/`    | 只负责把最终可投递文本发出去            |
| Telemetry   | `telemetry/`   | 观测失败不改变业务终态                  |

## 2. 核心服务

| 服务                                                                                                                  | 当前职责                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [MessageService](../../src/channels/wecom/message/message.service.ts)                                                 | 回调入口协调；立即 ACK 后异步分派                            |
| [AcceptInboundMessageService](../../src/channels/wecom/message/application/accept-inbound-message.service.ts)         | self 消息归档、过滤、去重、历史和图片准备                    |
| [ReplyWorkflowService](../../src/channels/wecom/message/application/reply-workflow.service.ts)                        | `runTurn`、有界 replay、最终副作用、投递、TurnFinalizer      |
| [SimpleMergeService](../../src/channels/wecom/message/runtime/simple-merge.service.ts)                                | Redis pending list、静默窗口 delayed job、租约锁与 follow-up |
| [MessageProcessor](../../src/channels/wecom/message/runtime/message.processor.ts)                                     | Bull worker、应用层并发槽、chat 串行、锁心跳                 |
| [MessageRuntimeConfigService](../../src/channels/wecom/message/runtime/message-runtime-config.service.ts)             | 托管配置快照与聚合/投递/模型选择                             |
| [MessageDeliveryService](../../src/channels/wecom/message/delivery/delivery.service.ts)                               | 最终文本分段、延迟和发送失败聚合                             |
| [WecomMessageObservabilityService](../../src/channels/wecom/message/telemetry/wecom-message-observability.service.ts) | batch trace 与消息流水的阶段打点                             |

## 3. 入站与快速 ACK

回调适配后，`MessageService` 立即返回成功，把实际处理放入异步任务。这样托管平台不会因模型或外部 API 延迟误判超时并重复补发。

入站处理依次完成：

1. self/source/contact/托管状态/黑名单/群聊/消息类型/空内容等过滤；
2. `wecom:message:dedup:{messageId}` 的 `SET NX EX` 去重；
3. 创建 trace 与单消息 `processing` 流水；
4. 异步写 user 对话历史；
5. 按模型能力准备图片描述或保留多模态输入；
6. 根据运行时聚合开关进入 pending，或直接进入单消息主编排。

命中过滤规则时，结果可以是完全忽略或仅归档历史；这两种终态都不会进入 Agent。

## 4. Debounce 与租约锁

聚合采用“距最后一条消息静默满 N 毫秒”的 debounce，不设最大聚合条数：

1. 每条消息 `RPUSH wecom:message:pending:{chatId}`；
2. 更新 `wecom:message:last-message-at:{chatId}`；
3. 为每条消息创建 `delay=mergeDelayMs` 的 Bull job；
4. worker 到点后复核静默窗口，不满足就等待后续 job 接力；
5. 满足时按当前快照 `LRANGE + LTRIM`，只裁掉本次读走的前缀。

### 4.1 三个锁时长

| 参数           | 当前值 | 不变量                                     |
| -------------- | -----: | ------------------------------------------ |
| pending TTL    |  300 s | 大于孤悬锁接管上界                         |
| 单次处理锁租约 |   90 s | 进程崩溃后尽快释放；不是整轮硬超时         |
| 心跳间隔       |   30 s | 小于租约一半，长 Agent/replay 期间持续续期 |
| 锁冲突重检延迟 |   30 s | 最坏约 120 s 内由新 worker 接管孤悬锁      |

锁 owner token 参与续期和释放，不能由其他 worker 误删。相同 `chatId` 的 Agent 回合必须串行；不同 chat 的真实并发由 `MessageWorkerManagerService` 的动态 semaphore 控制。

### 4.2 Worker 并发

Bull 注册并发上限为 20，使到期 delayed job 能及时出队；真正进入长耗时处理的数量由应用层 `currentConcurrency` 控制，默认 4。先取执行槽，再取 chat 锁；所有出口在 `finally` 释放。

## 5. Agent、Outcome 与 replay

`ReplyWorkflowService` 调用 `AgentRunnerService.runTurn()`，得到渠道无关的 `TurnOutcome`。每个生成版本都带一个 `runTurnEnd` 闭包，渠道立即包装为 `TurnFinalizer`，但直到投递结局已知才结算。

生成期间的新消息仍可进入 pending。每次生成完成后：

- 当前 outcome 可重放且有新消息：丢弃当前 finalizer，合入新消息后重跑；
- outcome 非 reply、含待提交副作用或成功调用 replay-blocking 工具：采用当前版本；
- 最多重跑 3 次；未消费消息由 follow-up job 接管。

当前成功后阻断 replay 的工具只有：

- `invite_to_group`
- `duliday_interview_booking`

`advance_stage` 不在阻断集合中。阻断判定必须调用 `blocksReplay()` 看工具结果是否真的提交成功，不能只看 tool name 出现。不可逆工具在提交前还会检查 `hasNewerUserInput`；命中新消息时以 stale-input 短路，允许旧回合继续 replay。

## 6. 最终副作用、投递与 TurnFinalizer

replay 定局后，渠道才通过 `TurnOutcomeInterventionService` 提交最终 outcome 声明的暂停托管、告警等副作用，避免被丢弃版本误操作外部系统。

投递分流：

- `reply`：经过 Delivery 分段发送；
- `skipped`：不发送文本；
- `guardrail_blocked` / `handoff`：执行对应人工兜底，不作为普通回复发送。

`TurnFinalizer` 收口记忆与真实世界一致性：

- replay 丢弃版本调用 `discard()`；
- 最终版本调用 `settle({ delivered })`；
- `delivered=false` 仍可吸收用户事实，但不投影未送达助手文本；
- chat 锁释放前 `await whenSettled()`，避免下一 job 与本轮 memory 写入并发。

## 7. 运行时配置

| 来源             | 内容                                                                     | 生效方式       |
| ---------------- | ------------------------------------------------------------------------ | -------------- |
| 环境变量         | AI/聚合默认开关、去重 TTL 等启动配置                                     | 重启           |
| `hosting_config` | `initialMergeWindowMs`、typing、workerConcurrency、WeCom 模型与 thinking | 运行时快照刷新 |
| 代码常量         | pending TTL、锁租约/心跳、follow-up 最小延迟、replay 上限                | 发版           |

`mergeDelayMs` fallback 为 2,000 ms；运营可通过托管配置调整。代码和文档不应把某次环境值（例如 3 秒）写成全局固定值。

## 8. Redis 契约

| Key                                      | 类型   |                  当前 TTL |
| ---------------------------------------- | ------ | ------------------------: |
| `wecom:message:dedup:{messageId}`        | String |                     300 s |
| `wecom:message:pending:{chatId}`         | List   |                     300 s |
| `wecom:message:last-message-at:{chatId}` | String |                     300 s |
| `wecom:message:lock:{chatId}`            | String | 单次租约 90 s，持锁时续期 |
| `wecom:message:trace:{messageId}:v2`     | Hash   |                      24 h |

完整 key 清单见 [Redis 数据模型](../db/redis-schema.md)。

## 9. 运行时不变量

1. 回调必须快速 ACK；长耗时操作不能回到同步路径。
2. pending 只能裁掉当前已读前缀，不能清空生成期间新到消息。
3. chat 锁必须用 owner token 条件续期/释放，并在长回合中持续心跳。
4. replay 只丢弃未投递的版本；已经成功提交外部动作的版本不能被静默改写。
5. outcome 副作用只在 replay 定局后提交。
6. 未送达回复不能进入助手记忆，turn-end 必须在释放 chat 锁前完成。
7. trace/监控失败不能改变业务投递终态，但必须留下可诊断日志。
