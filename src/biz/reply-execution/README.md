# 企微普通回复的执行与恢复

`reply-execution` 在执行模式（`execute`）下记录一轮企微回复的进度。候选人连问「门店在哪？」「几点上班？」，系统可以把两条提问合成一轮，再把地址和班次分两段发出。这里有**两条输入、一个回复回合、两段发送**。如果服务在发完地址后重启，系统需要找回原来写好的班次，并查清哪一段已被企微受理。

## 两张回复表各记什么

| 表 | 一行代表什么 | 在这个例子里 |
| --- | --- | --- |
| `agent_reply_inputs` | 一条输入消息的归属 | 两行。地址提问 A 和班次提问 B 各有自己的 `message_id`，都指向回合 R（`logical_turn_id`）。任务再次拿到 B 时，用 B 找到 R。 |
| `agent_reply_turns` | 一轮回复的进度 | 一行。R 的 `input_ids` 是 `[A, B]`，收尾时据此确认两条原消息。`recovery.replySegments` 保存待发原文，`delivery_result` 记录发送结果和已受理段数。 |

Redis 在入口按消息 ID 去重，把等候处理的消息放在队列里，并用会话锁协调同一聊天的任务。具体到「地址这一段发出去了吗」，要看这段对应的 `agent_action_records` 发送动作和 `agent_action_evidence` 回执。动作表保存当前采信结果，回执表按派发尝试和内容摘要保留每份凭证。同次尝试收到不同结果时，两份凭证都能查到。企微发送接口返回成功表示平台已受理，候选人是否已读仍未知。[消息收发架构与时序图](../../../docs/architecture/message-service-architecture.md#主聊收发时序)

## 正常发送怎样走完一轮

1. **登记输入（`preparing`）。** 调用模型前，`open()` 在同一企业、机器人账号和聊天内查找消息归属。A、B 是新输入时，它在一次数据库事务里创建 R，并把两条消息关联到 R。
2. **保存原文，开始发送（`planned`）。** 回复通过审核后，渠道用 `saveEffects()` 一次存好待发原文和收尾要用的业务结果（例如已预约的工单号）。`startDelivery()` 把回合标为可发送，渠道开始逐段发给企微。每段用原回合 ID 和段序号标识，每次实际发送前都检查当前托管权限。
3. **汇总整轮结果（`settled`）。** 投递结束时，`settle()` 写一次回合，记下发送到哪一段，并清除回合里的待发原文。两段都被企微受理时记为 2/2，中途关闭托管也可以结束发送，具体结果看 `delivery_result`。
4. **确认原消息（`acked`）。** 如果回复推荐了岗位，就按企微已受理的内容写入岗位记忆。如果这是首次完整受理的私聊回复，就记下开场事件，并在跟进开启时按原输入时间排一次「开场后未回复」跟进。收尾成功后，从 Redis 确认并移除 A、B，再把回合标为 `acked`。期间新来的消息 C 留给下一轮。

## 发一段文本要等几次数据库

普通文本首次发送成功时，每段等待 **2 次数据库请求**。发「地址」和「班次」两段一共等 **4 次**，整轮结果另写 **1 次**。

| 时机 | 本次请求做什么 |
| --- | --- |
| 调用企微前 | 先取得路由、核对会话锁和托管权限，再用一次 `claim` 核对回合并领取这段。只有新取得发送权且仍在有效期内的进程才会调用企微。数据库答复到达时已过期就停止。 |
| 企微受理后 | 一次 `settle` 同时写入分段回执和动作结果。地址的受理已有记录时，恢复任务可以跳过地址，接着处理班次。 |

若托管已关闭或路由暂时不可用，`inspect` 只核对已有动作。已经受理的段仍计入整轮，结果未知的段继续等回执。创建回合、保存原文、权限查询、输入确认和故障重试另计。[分段数据库函数](../../../supabase/migrations/20261125100000_ordinary_reply_segment_io.sql) · [两段回复的请求计数测试](../../../tests/channels/wecom/message/delivery/reply-chain.integration.spec.ts)

分段请求的数据库耗时、20 个 worker 下的首条回复等待时间和队列积压量，见[200 倍峰值隔离压测](../../../docs/technical/ordinary-reply-peak-load.md)。

## 服务重启后怎样接着发

`ReplyRecoveryService` 随 Cake 应用启动，启动时查一次，此后每分钟查一次。只要数据库中的 `next_check_at` 已经到了，任务就可以检查这个回合。每轮从最早的记录起取最多 25 个。如果企微回执提前唤醒了任务，而原进程仍持有租约，就等到租约到期再查。真正发送前，还要取得同一聊天的 Redis 锁，并通过回合执行权、分段执行权和托管权限检查。

**从何时算 5 分钟？** 数据库无法看到进程实际宕机的那一秒。原处理进程保存最终原文、开始投递或每分钟续租成功时，数据库会留下两个时间。以最后一次成功续租在 10:00 为例。

| 时间 | 程序会做什么 |
| --- | --- |
| 10:03 | 原进程的 3 分钟租约到期，其他实例有资格接手并核对每一段。 |
| 10:04 | 恢复任务若看到地址已受理、班次尚未发出，且仍允许托管，就只发班次。 |
| 10:05 | 到达这轮续发的截止点 `recovery.resumeUntil`。超过这个时刻就放弃剩余发送。重启、重复扫描或等待回执都不会延长这轮的截止时间。 |

| 恢复时看到什么 | 最后怎么处理 |
| --- | --- |
| 时间已过，只发过地址，班次从未派发 | 保留地址的受理结果，班次跳过，按 1/2 收尾。两段都没发时按 0/2 收尾。 |
| 地址请求已发出，但是否受理仍未知 | 先等能匹配该请求的可信回执。超过 5 分钟仍无定论，标记待核实。以后到达的回执留在原动作下，剩余班次不再发送。 |
| 两段都已受理，写岗位记忆或排跟进时中断 | 即使已经超过 5 分钟，也会按原回合补完记忆或跟进，再确认 A、B。同一轮推荐只计一次。 |
| 生成过程中断，审核后的原文还没保存 | 用已保存的业务结果收尾，需要接续对话或核实工单时通知人工。 |

需要人工核实时，回合的 `review_reason` 记录原因。核对企微回执或工单后，通过 `resolve_review` 记下核实人和凭证。[回合状态更新与人工核实 SQL](../../../supabase/migrations/20261125080000_resume_ordinary_replies.sql)

## 代码入口

| 文件 | 读这里能看到什么 |
| --- | --- |
| [reply-turns.service.ts](reply-turns.service.ts) | 本模块对外提供的回合操作，包括登记输入、保存分段、记录发送结果和确认输入。 |
| [reply-turns.repository.ts](reply-turns.repository.ts) | `transition()` 调用数据库函数 `transition_agent_reply_turn` 更新回合。`due()` 查询到期记录。 |
| [reply-recovery-lease.service.ts](reply-recovery-lease.service.ts) | 恢复任务怎样和正在处理消息的任务共用同一把聊天锁。 |
| [reply-workflow.service.ts](../../channels/wecom/message/application/reply-workflow.service.ts) | 企微侧的调用入口。`processMessageCore()` 登记输入，`ackDurableTurn()` 写岗位记忆、排跟进、确认原消息。 |
| [durable-reply-delivery.service.ts](../../channels/wecom/message/delivery/durable-reply-delivery.service.ts) | 逐段核对动作和回执，用原请求 ID 调用企微发送接口。 |
| [reply-recovery.service.ts](../../channels/wecom/message/delivery/reply-recovery.service.ts) | 启动和定时检查都通过 `recoverDue()` 选取到期回合，决定接着发送、补办本地事项或通知人工。 |

集成测试在两段之间重启应用，保留隔离数据库里的回合和回执，用模拟企微接口核对每段实际发送了几次。开场跟进入队失败后再次重启，也有对应的用例。[应用重启集成测试](../../../tests/channels/wecom/message/delivery/reply-chain.integration.spec.ts)

## 旧记录、切换与回滚

新建持久回合需要开启 `ACTION_EXECUTION_MODE=execute`，消息时间须达到配置的切换时刻 `ACTION_EXECUTION_CUTOVER_AT`。与消息排障一起发布时，按联合手册的顺序应用五份迁移，再部署应用。新版切回 `observe` 或 `off` 后，恢复任务仍处理已登记的 `execute` 回合。旧回合有分段却缺少可信截止时间时只核对已受理的部分。没有分段原文时按已有业务结果收尾或转人工。

这批迁移会删除旧应用使用的存储字段。回滚先停止派发，使用匹配的备份与应用，核对备份之后企微实际受理过的请求，再恢复流量。[切换与回滚](../../../docs/technical/runtime-storage-batch.md#验收与回滚) · [旧回合回归](../../../tests/biz/reply-execution/ordinary-reply.integration.sql)
