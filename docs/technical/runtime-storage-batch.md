# 消息存储与普通回复的联合迁移

这一批改变了两件事。排查一次消息处理时，可以分别还原 Cake 的回合上下文和每次模型 HTTP 请求。服务中断时，可以凭原回合和企微已受理的分段，在五分钟窗口内接着发送。两条链共享处理过程，数据的用途和主键不同。

## 基线与生产现状

前期改造已经进入 `develop`。#1546 引入流水与快照同事务写入、工单与动作回执治理，#1562 将快照默认保留期对齐到 90 天并退役主表旧列和策略变更表，#1568 收拢聊天与采信回执正文，#1584 按生产验收回写表结构。#1587 的处理详情与消息标识调整也在本次基线内。[一期治理](https://github.com/huajune/cake-agent-runtime/pull/1546) · [保留期与旧表退役](https://github.com/huajune/cake-agent-runtime/pull/1562) · [二期治理](https://github.com/huajune/cake-agent-runtime/pull/1568) · [生产验收](https://github.com/huajune/cake-agent-runtime/pull/1584) · [处理详情](https://github.com/huajune/cake-agent-runtime/pull/1587)

本手册按 #1588 与 #1589 的联合代码说明消息排障和普通回复的目标结构。另一个 PR 负责组织开户、托管绑定与租户隔离。[组织与租户改造 #1561](https://github.com/huajune/cake-agent-runtime/pull/1561)

发布 PR #1586 从 `develop` 发布到 `master`，实际包含的功能随 `develop` 提交变化。2026 年 11 月 26 日 11:38（北京）只读核对新加坡生产目录，最新登记为 `20261124100200`，下列五份迁移均未登记。生产当时仍使用每条流水至多一份的旧调用快照及动作采信指针。[消息排障](https://github.com/huajune/cake-agent-runtime/pull/1588) · [普通回复续发](https://github.com/huajune/cake-agent-runtime/pull/1589) · [发布 PR](https://github.com/huajune/cake-agent-runtime/pull/1586) · [已验收的生产结构](../db/database-schema.md)

## 数据怎么写、怎么查

| 要回答的问题 | 联合迁移后的存储与读取 |
| --- | --- |
| 这条消息怎么处理，工具当时返回了什么？ | `message_processing_records` 每次处理一行。`tool_calls` 保留调用参数和结果，可归属时用 `stepPosition` 指向 `agent_steps` 的零起始位置。步骤只存自身信息。供应商原文和 SDK 消息中可能出现相同的工具指令或结果，它们保留当时实际传输的内容。列表读摘要，工具统计读主表。[流水仓储](../../src/biz/message/repositories/message-processing.repository.ts) |
| Cake 为本轮准备了什么，最后怎么回复？ | 原先每条流水至多一份的快照迁入 `message_processing_turn_snapshots`，以 `message_id` 关联。`request` 与 `response` 分列保存。总部详情首屏读聊天上下文和回合响应，打开提示词或 Agent 请求才取完整请求。[详情接口](../../src/biz/message/message.controller.ts) |
| 模型供应商实际收发了什么？ | `message_processing_invocations` 沿用了旧表名，现为一次 HTTP 尝试一行。同轮重试和换供应商各有调用 ID。总部按处理 ID 取清单，再按处理 ID 和调用 ID 读该次原始字节。可续发普通回复在保存审核分段时，同事务保存主流水、回合快照及已捕获的调用。当回合结算，数据库据企微已受理的段更新流水结果。其他入口在收尾时提交。响应中断时只保留已捕获的字节，首次提交前宕机仍可能缺少原文。历史 SDK 快照不能补出供应商原文。[采集与存储](../../src/observability/context/model-invocations.ts) · [读写事务](../../supabase/migrations/20261125080100_processing_snapshot_storage.sql) |
| 某条输入归哪一轮，服务重启后要不要发下一段？ | Redis 管待处理输入与会话锁。`agent_reply_inputs` 按输入找回合，`agent_reply_turns` 保存已审核分段、执行权、期限和结局。恢复任务先核对已受理的段，在原进程最后一次保存分段、开始投递或成功续租后的 5 分钟内可以接着发。超过期限就放弃未发部分，按已有凭证收尾。[主聊时序](../architecture/message-service-architecture.md#主聊收发时序) · [恢复实现](../../src/biz/reply-execution/README.md) |
| 一次动作最终采信了什么，另一次回执说了什么？ | `agent_action_records.result/evidence` 保存动作当前采信的结果及依据。`agent_action_evidence` 按企业、动作、派发尝试和回执摘要保留各次观察，迟到或冲突回执仍可核查。预约从动作结果或其原有恢复信息读取工单号。普通文本每段发前一次核对并领取，受理后一次保存本段回执及结果。人工裁定由 `agent_action_reviews` 记录。[动作与回执](runtime-action-records.md) · [分段事务](../../supabase/migrations/20261125100000_ordinary_reply_segment_io.sql) |
| 原渠道消息、测试响应和工具内部判断从哪里来？ | 渠道会话读 `chat_messages.payload`，测试读 `test_executions.agent_response`。工具内部埋点按 trace 和可确定的调用归属展示。`agent_execution_events` 的 `tool_call` 在涉及副作用、错误、空结果、窄结果或耗时至少 3 秒时留存。调用总数取主流水。守卫审查、转人工工单及运营事件各有独立记录。[排障读法](../knowledge-base/10-可观测性体系.md#一条消息如何留档) |

这次移除十个旧存储字段。主流水移除 `step_tools_v1`、`invocation_version`，旧回合快照移除 `write_version`、`response_tools_v1`、`superseded_invocation`。聊天、测试各移除 `payload_text_v1`、`response_text_v1`，动作主表移除 `body_ref_v1`、`accepted_attempt_id`、`accepted_evidence_hash`。另外，旧回合快照的 `agent_invocation` 拆成请求与响应两列。更早删除的主流水同名字段属于 #1562。[快照迁移](../../supabase/migrations/20261125080100_processing_snapshot_storage.sql) · [正文迁移](../../supabase/migrations/20261125081000_retire_body_storage_markers.sql)

## 发布顺序

先保存可恢复的数据库备份和对应应用版本，在测试库演练同一组迁移。按下表的版本顺序应用。准备阶段可在线还原。结构切换前暂停旧应用、后台写入及旧导出，等待在途写入结束，核对备份可恢复至停写时点。

| 次序 | 迁移 | 操作与核对 |
| --- | --- | --- |
| 1 | [20261125075900](../../supabase/migrations/20261125075900_prepare_storage_cutover.sql) | 停止写旧压缩格式。旧应用此时仍能读写完整正文。可先按主键每批至多还原 250 行，脚本支持中断重跑。核对聊天、测试和动作标记剩余量。采信凭证不匹配会中止当批。[分批还原脚本](../../scripts/backfill-runtime-bodies.sql) |
| 2 | [20261125080000](../../supabase/migrations/20261125080000_resume_ordinary_replies.sql) | 暂停旧写入后安装回合函数。原进程租约 3 分钟，续发窗口 5 分钟。缺少可信截止时间的旧回合只核对已受理部分。 |
| 3 | [20261125080100](../../supabase/migrations/20261125080100_processing_snapshot_storage.sql) | 原快照迁至回合表，保留可用历史上下文与创建时间，旧表名用于逐次 HTTP 原文。确已被替代或旧引用无法校验的快照会退出详情，对应主流水保留。 |
| 4 | [20261125081000](../../supabase/migrations/20261125081000_retire_body_storage_markers.sql) | 还原剩余正文，删除旧字段、触发器和写入开关。以同次派发存在多个回执的预约核对主表采信的结果、工单号及历史回执。 |
| 5 | [20261125100000](../../supabase/migrations/20261125100000_ordinary_reply_segment_io.sql) | 安装分段领取和受理结算。部署同时包含两项功能的应用后恢复流量。两段成功发送应产生四次分段数据库请求，另有一次整轮结算。 |

在线分批还原使用已确认的目标库连接，执行 `psql -X -v ON_ERROR_STOP=1 -f scripts/backfill-runtime-bodies.sql`。切换完成后抽查一条带媒体的聊天和一条测试执行，核对渠道正文与测试响应。

本批生产主聊首档为 **每实例 50 槽**。正式发版流程在新容器健康检查通过后调用后台接口设置 50，再读取该实例状态。完成条件是配置值 50、Bull 已注册 50、上限 100。已领取的任务先处理完，新消息可继续入队。此项沿用现有 `system_config`，适用于五份数据库迁移完成后的新应用。[生产首档与复核](../workflows/deploy-guide.md#主聊并发首档) · [并发设计](../architecture/message-service-architecture.md#42-worker-并发)

## 验收与回滚

- 用一条升级前的流水核对回合快照与原创建时间。用一条升级后发生重试或换供应商的流水，分别核对每次 HTTP 状态和请求、响应字节。中心账号只能读授权 BOT 的摘要，总部才可按需读请求和模型原文。两类快照默认保留 90 天，共用每批行数上限。回合按 `created_at`，模型请求按 `started_at`，主流水删除时均级联清理。[监控与接口](../architecture/monitoring-system-architecture.md#api-端点列表)
- 模拟第一段受理后重启，核对第一段的原派发回执、第二段的发送次数，以及超时或关闭托管后的结局。回执不明时等待原尝试的可信证据。有已受理内容时按原回合补齐记忆和跟进，再确认输入。[宕机回归](../../tests/channels/wecom/message/delivery/reply-chain.integration.spec.ts) · [容量复测](ordinary-reply-peak-load.md)
- 删列前旧应用可读已经还原的正文。删列后回滚需要匹配的应用和数据库备份。恢复流量后又要回滚时，先停派发，核对备份时点之后企微已经受理的请求和晚到回执，避免重放外部动作。生产验收后再回写表结构、实际迁移版本和清理结果。[生产结构](../db/database-schema.md)

## 本地回归

在一次性 PostgreSQL 上运行联合迁移核验。历史数据升级用例从 `20261124100200` 的相关依赖起步，分别演练直接升级及先分批还原（`-v prebackfill=1`）。分段并发和队列压测运行在删列后的结构上。[冷启动入口](../../tests/biz/action-execution/verify-runtime-postgres.py) · [历史升级用例](../../tests/supabase/storage-cutover.integration.sql) · [流水、权限与回执用例](../../tests/supabase/runtime-data-governance.sql) · [中心与预约用例](../../tests/supabase/runtime-storage-batch.sql)

2026 年 11 月 26 日的两条隔离升级路径均通过。预约样例里，第一次派发有工单 101、102 两份回执，另一尝试报告 103。升级后动作主表仍采信 101，证据表保留三份。260 条历史聊天的原载荷、测试响应以及可读快照的创建时间也逐项核对通过。[升级前的造数与升级后断言](../../tests/supabase/storage-cutover.integration.sql)

并发回归在一次性 Redis 上分别运行普通连接和生产使用的 Upstash 逐槽连接方式。按 20 → 50 → 100 → 2 逐档核对 Bull 的 active 与 waiting，每组 282 个任务各完成一次，包含切换期间入队及队列空闲后的延迟任务。重启后读回保存的 50。Linux 上另连续运行 180 次注册后立即关停，阻塞连接登记得到确认，未发生未处理的 Promise 拒绝。复测时将 `ISOLATED_MESSAGE_WORKER_REDIS_PORT` 指向一次性 Redis 的本机端口，然后运行 `pnpm exec jest --runInBand --watchman=false tests/channels/wecom/message/runtime/message-worker-concurrency.redis.spec.ts`。[实队列回归](../../tests/channels/wecom/message/runtime/message-worker-concurrency.redis.spec.ts)

## 发布与历史清理

2026 年 11 月 25 日已验收的三份迁移、当时开启的压缩开关和逐键还原办法保存在对应版本。排查旧版本时使用该版本的脚本和手册。[11 月 25 日归档手册](https://github.com/huajune/cake-agent-runtime/blob/4aed81b5877017d9d701c160db5d638972053a7f/docs/technical/runtime-storage-batch.md#发布与历史清理) · [生产验收记录](https://github.com/huajune/cake-agent-runtime/pull/1584)
