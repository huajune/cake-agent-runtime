# 主聊回复回合的持久化实现

本模块封装回复回合的 PostgreSQL 读写及恢复任务使用的 Redis 会话锁。正常收发、宕机续发的两张时序图，以及 Redis、回合表和分段动作表的分工，见[企微消息服务架构](../../../docs/architecture/message-service-architecture.md#主聊收发时序)。

## 输入归属与代码入口

`ReplyWorkflowService.processMessageCore()` 在调用 Agent 前把企业、机器人账号、聊天和这批原消息 ID 传给 `ReplyTurnsService.open()`。`ACTION_EXECUTION_MODE=execute` 时校验输入时间、`ACTION_EXECUTION_CUTOVER_AT` 与输入成员。`observe/off` 且切换时间为空时直接返回。已配置切换时间时，仍可查回先前登记的执行回合。[渠道入口](../../channels/wecom/message/application/reply-workflow.service.ts) · [回合服务](reply-turns.service.ts)

`ReplyTurnsRepository.transition()` 调用 RPC `transition_agent_reply_turn`。`open` 在同一事务中取得企业、账号、聊天作用域的事务锁，先用 `agent_reply_inputs` 联查原回合，再检查同一聊天的在途回合。需要新建时，同时写入以下两种记录。[仓储](reply-turns.repository.ts) · [主外键定义](../../../supabase/migrations/20261021100000_reply_turns.sql) · [RPC 实现](../../../supabase/migrations/20261125080000_resume_ordinary_replies.sql)

| 表 | 读写契约 |
| --- | --- |
| `agent_reply_inputs` | 联合主键为 `(corp_id, account_id, chat_id, message_id)`。`(corp_id, logical_turn_id)` 外键关联回合。同一作用域内的一条消息只能登记一次。 |
| `agent_reply_turns` | 主键为 `(corp_id, logical_turn_id)`。`input_ids` 固定本轮输入集合。`owner`、`fence` 和 `generation_until` 用于校验执行权，`recovery` 保存路由、业务结果及已确定的分段，`delivery_result` 保存投递结局。 |

同一组输入重试时，`claimPendingSnapshot()` 按去重后的消息 ID 集合生成稳定的 `batchId`。实际取得生成权的任务才创建批次流水。已有回合仍由其他执行者持有时，聚合任务安排 30 秒后重检。[待处理列表](../../channels/wecom/message/runtime/simple-merge.service.ts) · [队列任务](../../channels/wecom/message/runtime/message.processor.ts)

## 状态转换与分段投递

| 操作 | 前置条件与写入 |
| --- | --- |
| `open`、`renew` | 新回合从 `preparing` 开始，原执行者持有 10 分钟数据库租约。`withGenerationLease()` 每分钟校验执行权并续租。 |
| `save_reply` | 渠道按当时的配置切分通过守卫的最终文本。`saveEffects(turn, effects, segments)` 在同一事务写入 `recovery.replySegments` 与 `recovery.effects`，重复提交须与已存值相同。仅有业务结果时使用 `save_effects`。 |
| `start_delivery`、`check_delivery` | `start_delivery` 从 `preparing` 转为 `planned`。每段派发前，`check_delivery` 复核状态、`owner`、`fence` 和租约，动作执行器同时检查当前托管权限。 |
| `settle` | 正常结算时写 `delivery_result` 的 `outcome`、`accepted` 和 `total`，移除 `replySegments` 并置 `settled`。尚待人工核实的超期分段由 `resume_delivery` 保留，供核对原文。 |
| `ack` | 本地业务结果完成补账后，`ackDurableTurn()` 依据分段结果写入岗位记忆、开场或普通回复事件、复聊排程，并提交已保存的人工跟进意图。再按 `input_ids` 确认 Redis 原消息，再置 `acked` 并清理临时跟进资料。 |

分段的动作类型为 `wecom.reply_segment`，`intentId` 由原回合 ID 和段序号生成。`DurableReplyDeliveryService.sendOrdinarySegment()` 通过 `ActionExecutorService` 复用已登记的动作，发送时携带原 `externalRequestId`。发送 API 返回 `errcode=0` 可直接采信。经验证的自发回调通过 `append_agent_reply_callback` 匹配原请求，留存回执。每次派发的凭证与动作当前采信的结果分别保存在 `agent_action_evidence` 和 `agent_action_records`。[分段准备与发送](../../channels/wecom/message/delivery/delivery.service.ts) · [分段动作](../../channels/wecom/message/delivery/durable-reply-delivery.service.ts) · [动作执行器](../action-execution/action-executor.service.ts) · [回调匹配](../../channels/wecom/message/message.service.ts)

## 恢复查询与执行权

- `ReplyRecoveryService.recoverDue()` 由企微消息模块注册，每分钟调用一次 `ReplyTurnsRepository.due()`。筛选执行档（`mode = 'execute'`）、带主聊上下文（`recovery->'primary' IS NOT NULL`）且 `next_check_at` 已到的记录，按检查时间升序取最多 25 行。同实例用 `running` 防止重入，开始处理下一行前检查本轮 30 秒时间预算。[模块注册](../../channels/wecom/message/message.module.ts) · [定时任务](../../channels/wecom/message/delivery/reply-recovery.service.ts) · [到期查询](reply-turns.repository.ts)
- 每个回合先由 `ReplyRecoveryLeaseService.run(chatId)` 取得与线上聚合任务共用的 Redis 租约。对 `preparing/planned` 且已经保存最终分段的回合，`resume_delivery` 再在数据库内校验原 `owner`、`fence` 和租约到期时间。接管时更换 `owner`、递增 `fence`，新租约最长 90 秒，且截止于原输入时间后 24 小时。[会话租约](reply-recovery-lease.service.ts) · [接管条件](../../../supabase/migrations/20261125080000_resume_ordinary_replies.sql)
- `resumeDelivery()` 先补待处理的本地业务结果，再沿原路由、原段序号恢复投递。`resumeSegments()` 跳过已受理段，在途或结果未知的段等待可信回执，尚未派发的段按原文发送。明确的连接前失败可有限重试。权限撤回后停止剩余派发，超出恢复期限转人工。已经结案的回合只处理原结局和本地收尾。[回合收尾](../../channels/wecom/message/application/reply-workflow.service.ts) · [逐段恢复](../../channels/wecom/message/delivery/durable-reply-delivery.service.ts)
- `ackPendingMessageIds()` 用 Lua 匹配待处理列表中的消息 ID，响应丢失时用同一组 ID 有界重试。各模式都按本轮实际接纳的输入确认。未固定回合的 replay 路径重新读取当前列表，按消息 ID 排除已知输入。无法解析或缺少身份的项保留并记错。[Redis 确认实现](../../channels/wecom/message/runtime/simple-merge.service.ts)

### 已受理分段的收尾

`save_reply` 把 `effects.deliveredReply` 和待发原文一并保存。岗位部分按「前几段得到受理」记录应展示的岗位 ID、焦点及本轮展示次数，同一岗位摘要只存一份。派发暂缓和最终结算都按实际受理段数应用，重复执行沿用原展示次数。成功确认输入后，RPC 删除这份临时资料。旧记录沿用已有的收尾信息。[岗位选择](../../memory/short-term/assistant-job-projection.ts) · [会话状态写入](../../memory/short-term/workbench.service.ts)

完整私聊回复走同一个收尾入口。首次开场事件绑定原回合，再用原输入时间和稳定的 `opening` 锚点提交 `opening_no_reply`。其他回复按原文符合的条件提交推店、收资或缺定位跟进。首次开场询问位置时只排开场跟进。运营事件、排程或输入确认失败时，下一次检查按原身份重试。[渠道收尾](../../channels/wecom/message/application/reply-workflow.service.ts) · [复聊判定](../../agent/reengagement/anchor.service.ts) · [排程去重](../../agent/reengagement/follow-up-scheduler.service.ts)

## 人工核实与业务补账

恢复任务在原回合记录 `review_reason`、投递结局与通知时间。`business_effects_unconfirmed` 表示生成中断或业务结果落库未获确认。数据库保留回合及输入归属，队列可移除这组输入的 Redis 副本。若模型线路均故障且实时工具计数确认零次执行，则记录零发送并通知人工接续。通知包含企业、回合、输入与流水 ID。飞书确认后记录通知时间，失败按 1、2、4 分钟递增重试，上限 30 分钟。[恢复与通知](../../channels/wecom/message/delivery/reply-recovery.service.ts)

服务账号用 `transition_agent_reply_turn('resolve_review', p_input)` 记入人工核实结果。参数包括原 `corpId/accountId/chatId/logicalTurnId`、核实人 `verifiedBy` 和凭证引用 `evidenceRef`。对 `business_effects_unconfirmed`，还需按 `ordinaryReplyEffects` 结构提供核实后的 `effects`。只有外部凭证确认无业务动作时才填空的 `toolCalls`。相同凭证与结果可重试。对已确认输入、业务补账完成的模型故障、投递中断或超期回合，可凭核实人和凭证关闭待核实标记。[核实 RPC](../../../supabase/migrations/20261125080000_resume_ordinary_replies.sql) · [业务结果结构](../../channels/wecom/message/application/ordinary-reply-effects.ts)

主聊报名后的面试排程、取消终态、群邀请后的复聊停止命令，按原工单结果和业务身份补账。排程入队失败只补该次入队。回复承诺的人工跟进意图用原幂等键，按投递结果在确认输入前提交。群任务与到期复聊由各自的处理链执行。

## 旧记录、切换与回滚

11 月 6 日的 `single_pass` 客户端仅在原进程发送。按段续投递沿用 `delivery_policy = single_pass` 以兼容旧应用，实际接管条件取决于回合状态和已保存的 `replySegments`。先应用 11 月 25 日的 RPC 迁移，再部署配套应用。旧回合缺少待发分段时走原有收尾或人工核实。配置回到 `observe/off` 后，新版仍接手已登记的 `execute` 回合。应用回退时数据库保留新回合的分段，恢复支持续发的版本后可继续处理。[旧发送策略](../../../supabase/migrations/20261106160000_ordinary_reply_single_pass.sql) · [续投递迁移](../../../supabase/migrations/20261125080000_resume_ordinary_replies.sql)

11 月 12 日退役旧冻结方案与独立排程协议的迁移，要求 `frozen` 回合、非空旧计划、旧群任务和复聊待补办事项为零，并在事务内复核。当次收缩以 v11.15.6 为最低回退应用，回退保留数据库、原执行模式与切换边界。该迁移对应的测试、回退镜像核对及生产部署顺序见运行能力文档。[退役迁移](../../../supabase/migrations/20261112020000_retire_main_reply_compat.sql) · [开关与部署顺序](../../../docs/architecture/runtime-capabilities.md#开关与部署顺序)

## 验证

| 测试入口 | 覆盖行为 |
| --- | --- |
| [PostgreSQL 回合事务](../../../tests/biz/reply-execution/ordinary-reply.integration.sql) | 分段不可改写、租约过期接管、旧执行者隔离、超期与旧回合兼容。 |
| [渠道链路集成测试](../../../tests/channels/wecom/message/delivery/reply-chain.integration.spec.ts) | 真实 Nest/SQL 与模拟企微验证企业和小组路由，首段前、分段间、全部受理后宕机，以及晚到回执、撤回托管权限、业务补账和输入确认。 |
| [投递单测](../../../tests/channels/wecom/message/services/delivery.service.spec.ts) | 明确受理、连接前有限重试、未知结果、权限变更与实际受理文本。 |
| [Redis 输入确认](../../../tests/channels/wecom/message/pending-inputs.redis.cjs) | 队列过期重建、确认响应丢失、部分或重复确认、异常项隔离。 |

PostgreSQL 用例使用 `CAKE_REPLY_TEST_CONTAINER` 和 `CAKE_REPLY_TEST_DATABASE` 指向无网络、无端口映射的隔离容器。Redis 用例只接受 `cake-pending-ack-` 前缀、无网络且无映射端口的测试容器。
