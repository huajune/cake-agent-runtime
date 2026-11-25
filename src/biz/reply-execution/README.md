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
3. **记录发送结果（`settled`）。** `settle()` 记下发送到哪一段，并清除回合里的待发原文。两段都被企微受理时记为 2/2，中途关闭托管也可以结束发送，具体结果看 `delivery_result`。
4. **确认原消息（`acked`）。** 如果回复推荐了岗位，就按企微已受理的内容写入岗位记忆。如果这是首次完整受理的私聊回复，就记下开场事件，并在跟进开启时按原输入时间排一次「开场后未回复」跟进。收尾成功后，从 Redis 确认并移除 A、B，再把回合标为 `acked`。期间新来的消息 C 留给下一轮。

## 服务重启后怎样接着发

`ReplyRecoveryService` 随 Cake 应用一起启停。只要有实例运行，它就每分钟查一次 `agent_reply_turns`，按下次检查时间（`next_check_at`）取最早到期的最多 25 个普通回复回合。

恢复任务取得这个聊天的 Redis 锁后，还要核实原实例在数据库里的执行权已经到期，才能接着发送。数据库用 10 分钟的租约保护原实例，工作期间每分钟续租，因此服务刚重启时可能还要等几分钟才能续发。

| 重启时查到的进度 | 恢复任务怎么做 |
| --- | --- |
| 地址已受理，班次还没发 | 跳过地址。当前托管仍允许回复时，向原聊天发送保存好的班次。 |
| 地址请求已发出，回合仍在投递，企微是否受理还未知 | 等待能匹配原请求的可信回执，班次也先等。自原输入起满 24 小时仍有分段待确认，就交人工核实。 |
| 两段都已受理，写岗位记忆或排跟进时中断 | 按原回合补完记忆或跟进，再确认 A、B。同一轮推荐仍计一次，同一个开场跟进复用原任务 ID。 |
| 生成过程中断，审核后的原文还没保存 | 按已保存的业务结果收尾，需要接续对话或核实工单时通知人工。恢复任务只续发已经保存的原文。 |

需要人工核实时，回合的 `review_reason` 记录原因。核对企微回执或工单后，通过 `resolve_review` 记下核实人和凭证。[回合状态更新与人工核实 SQL](../../../supabase/migrations/20261125080000_resume_ordinary_replies.sql)

## 代码入口

| 文件 | 读这里能看到什么 |
| --- | --- |
| [reply-turns.service.ts](reply-turns.service.ts) | 本模块对外提供的回合操作，包括登记输入、保存分段、记录发送结果和确认输入。 |
| [reply-turns.repository.ts](reply-turns.repository.ts) | `transition()` 调用数据库函数 `transition_agent_reply_turn` 更新回合。`due()` 查询到期记录。 |
| [reply-recovery-lease.service.ts](reply-recovery-lease.service.ts) | 恢复任务怎样和正在处理消息的任务共用同一把聊天锁。 |
| [reply-workflow.service.ts](../../channels/wecom/message/application/reply-workflow.service.ts) | 企微侧的调用入口。`processMessageCore()` 登记输入，`ackDurableTurn()` 写岗位记忆、排跟进、确认原消息。 |
| [durable-reply-delivery.service.ts](../../channels/wecom/message/delivery/durable-reply-delivery.service.ts) | 逐段核对动作和回执，用原请求 ID 调用企微发送接口。 |
| [reply-recovery.service.ts](../../channels/wecom/message/delivery/reply-recovery.service.ts) | 定时任务 `recoverDue()` 选取到期回合，决定接着发送、补办本地事项或通知人工。 |

集成测试在两段之间重启应用，保留隔离数据库里的回合和回执，用模拟企微接口核对每段实际发送了几次。开场跟进入队失败后再次重启，也有对应的用例。[应用重启集成测试](../../../tests/channels/wecom/message/delivery/reply-chain.integration.spec.ts)

## 旧记录、切换与回滚

新建持久回合需要开启 `ACTION_EXECUTION_MODE=execute`，消息时间须达到配置的切换时刻 `ACTION_EXECUTION_CUTOVER_AT`。先应用续发迁移，再部署应用。新版切回 `observe` 或 `off` 后，恢复任务仍处理已登记的 `execute` 回合。回退应用时保留待发分段，恢复支持续发的版本后可继续发送。旧回合如果缺少分段原文，就按已保存的结果收尾或转人工。[部署与回滚顺序](../../../docs/architecture/runtime-capabilities.md#开关与部署顺序) · [新旧版本兼容测试](../../../tests/biz/reply-execution/ordinary-reply.integration.sql)
