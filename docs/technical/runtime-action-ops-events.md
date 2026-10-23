# 外部动作成功后的运营事件补账

`ActionOpsEventService.sync` 把已确认成功的报名、取消、改约投影为历史事件。调用方必须在确认外部成功、核实原工单编号后调用，并在任何本地版本早退之前完成。恢复仅补历史记录，不查询海绵、不重做报名、不邀请进群、不发送通知。

| 动作             | 事件                         | 保留的业务幂等键                           |
| ---------------- | ---------------------------- | ------------------------------------------ |
| `sponge.booking` | `booking.succeeded`          | 原工单编号                                 |
| `sponge.cancel`  | `booking.canceled`           | `工单编号:canceled`                        |
| `sponge.modify`  | `booking.interview_modified` | `工单编号:interview_modified:原新面试时间` |

事件时间使用持久意图的 `occurredAt`，不会因为次日恢复而落入次日报表。展示元数据来自派发前冻结的 `recovery.opsEventPayload`；老记录缺少这些字段时，只记录有证据的最小事实。企业、会话、账号以及逻辑回合沿用原意图。

可靠入口 `recordEventDurably` 仅在数据库确认插入/重复，或关键恢复队列确认接收之后完成。两个通道都失败会抛错，让动作的本地同步保持待处理。可选 `assertOwned` 在数据库写入、后续进群元数据写入、队列入队前分别检查租约。队列使用原事件幂等键，指数退避重试耗尽后保留失败任务并告警；修复记账不能重放外部动作。

报名事实可能先于独立进群结果落账。后续同一报名事件通过 `enrich_booking_invite_event` 精确锁定企业、事件类型和幂等键，仅补 `group_invite` 的 `outcome / attempted / success / city / group_name / delivery / simulated`。已知终态不被迟到的未知结果覆盖；缺失或 `unknown` 可被后续证据补齐。该 RPC 不插入事件、不更新发生时间、不重复投影日报计数，只有 `service_role` 有执行权限。基础事件与后续进群元数据使用不同队列任务编号，避免前者仍在重试时吞掉后者。

## 验证记录

2026-10-21，本地隔离 PostgreSQL 15 容器 `cake-runtime-pg-20261021`（无网络、无映射端口）专用数据库 `cake_action_ops_projection`：

- 合成两家企业的同编号报名以及一条取消记录，断言仅目标报名更新；记录总数、原时间和原报表日不变。
- `unknown → invited → unknown` 重放仍保留 `invited`；白名单之外的字段不写入；缺失记录返回 false。
- 验证匿名及 authenticated 角色不能执行，service_role 可以；重复应用迁移及重复调用均成功。
- 事务内另造 150,000 条合成事件，使用与现有迁移相同的 `(corp_id, event_name, idempotency_key)` 唯一索引；对函数中的精确锁定查询运行 `EXPLAIN (ANALYZE, BUFFERS)` 后回滚。计划为 `LockRows → Index Scan`，索引条件包含三个等值键，实际返回 1 行、shared hit 5、无临时文件，执行 0.058 ms。该数值仅表示隔离实验，不代表生产延迟。

TypeScript 类型检查、4 套运营事件测试（19 项）及完整 AppModule 依赖装配冒烟通过。故障测试覆盖数据库失败但队列接收、两个通道均失败、数据库写后租约失效、原时间/幂等键、基础与进群补充队列分离。未执行任何测试/生产 Supabase 迁移，实际部署须按仓库既有迁移流程联动代码。
