# 企微普通回复的执行与恢复

`reply-execution` 在执行模式（`execute`）下记录一轮企微回复的进度。候选人连问「门店在哪？」「几点上班？」，系统可以把两条提问合成一轮，再把地址和班次分两段发出。这里有**两条输入、一个回复回合、两段发送**。如果服务在发完地址后重启，系统需要找回原来写好的班次，并查清哪一段已被企微受理。

## 两张回复表各记什么

| 表 | 一行代表什么 | 在这个例子里 |
| --- | --- | --- |
| `agent_reply_inputs` | 一条输入消息的归属 | 两行。地址提问 A 和班次提问 B 各有自己的 `message_id`，都指向回合 R（`logical_turn_id`）。任务再次拿到 B 时，用 B 找到 R。 |
| `agent_reply_turns` | 一轮回复的进度 | 一行。R 的 `input_ids` 是 `[A, B]`，收尾时据此确认两条原消息。`recovery.replySegments` 保存待发原文，`delivery_result` 记录发送结果和已受理段数。 |

Redis 在入口按消息 ID 去重，把等候处理的消息放在队列里，并用会话锁协调同一聊天的任务。具体到「地址这一段发出去了吗」，要看这段对应的 `agent_action_records` 发送动作和 `agent_action_evidence` 回执。企微发送接口返回成功表示平台已受理，候选人是否已读仍未知。[消息收发架构与时序图](../../../docs/architecture/message-service-architecture.md#主聊收发时序)

## 正常发送怎样走完一轮

1. **登记输入（`preparing`）。** 调用模型前，`open()` 在同一企业、机器人账号和聊天内查找消息归属。A、B 是新输入时，它在一次数据库事务里创建 R，并把两条消息关联到 R。
2. **保存原文，开始发送（`planned`）。** 回复通过审核后，渠道用 `saveEffects()` 一次存好待发原文和收尾要用的业务结果（例如已预约的工单号）。`startDelivery()` 把回合标为可发送，渠道开始逐段发给企微。每段用原回合 ID 和段序号标识，每次实际发送前都检查当前托管权限。
3. **汇总整轮结果（`settled`）。** 投递结束时，`settle()` 写一次回合，记下发送到哪一段，并清除回合里的待发原文。两段都被企微受理时记为 2/2，中途关闭托管也可以结束发送，具体结果看 `delivery_result`。
4. **确认原消息（`acked`）。** 如果回复推荐了岗位，就按企微已受理的内容写入岗位记忆。如果这是首次完整受理的私聊回复，就记下开场事件，并在跟进开启时按原输入时间排一次「开场后未回复」跟进。收尾成功后，从 Redis 确认并移除 A、B，再把回合标为 `acked`。期间新来的消息 C 留给下一轮。

## 发一段文本要等几次数据库

普通回复在 `execute` 首次发送一段、企微正常受理时，应用会等待 **3 次数据库请求**。每次事务都先结束，再进行下一步。

| 顺序 | 本次请求做什么 | 为什么要等 |
| --- | --- | --- |
| 1 | `transition_agent_reply_segment('claim')` 核对回合执行权，在同一事务登记并领取这段的发送动作。 | 两个实例同时处理同一段，只有领到这次发送权的实例能继续。已有受理记录的段可以直接跳过。 |
| 2 | 解析路由、检查 Redis 会话锁和当前托管权限后，调用同一数据库函数的 `validate_claim`，一起复核回合和分段的执行权。 | 上述检查期间可能发生接管或超过续发截止时间。通过后才调用企微。 |
| 3 | 企微受理后，`transition_agent_action('settle')` 在一个事务保存这次回执、更新动作状态，并将这个文本动作标为完成。 | 企微明确受理第一段后才发第二段。回执写入暂时失败时，沿用原请求补记。岗位记忆、跟进和输入确认由整轮统一处理。 |

发「地址」和「班次」两段，分段路径合计 **6 次**，另外用 **1 次** 写整轮发送结果。创建回合、保存原文、检查权限、确认输入以及故障重试各有自己的开销。可以从集成测试查看实际请求的顺序和次数。[分段数据库函数](../../../supabase/migrations/20261125100000_ordinary_reply_segment_io.sql) · [两段回复的请求计数测试](../../../tests/channels/wecom/message/delivery/reply-chain.integration.spec.ts)

## 服务重启后怎样接着发

`ReplyRecoveryService` 随 Cake 应用启动，启动时查一次，此后每分钟查一次。只要数据库中的 `next_check_at` 已经到了，任务就可以检查这个回合。每轮从最早的记录起取最多 25 个。真正发送前，还要取得同一聊天的 Redis 锁，并通过回合执行权、分段执行权和托管权限检查。

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

新建持久回合需要开启 `ACTION_EXECUTION_MODE=execute`，消息时间须达到配置的切换时刻 `ACTION_EXECUTION_CUTOVER_AT`。先按顺序应用续发和分段读写两份迁移，再部署应用。新版切回 `observe` 或 `off` 后，恢复任务仍处理已登记的 `execute` 回合。回退期间保留已存原文与截止时刻，切回支持续发的版本时仍按原期限处理。旧回合如果有分段却缺少可信截止时间，只核对已受理的部分。没有分段原文时按已保存的业务结果收尾或转人工。[部署与回滚顺序](../../../docs/architecture/runtime-capabilities.md#开关与部署顺序) · [新旧版本兼容测试](../../../tests/biz/reply-execution/ordinary-reply.integration.sql)
