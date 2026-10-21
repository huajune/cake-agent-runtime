# 运行能力迁移的隔离 PostgreSQL 核验

入口为 `tests/biz/action-execution/verify-runtime-postgres.py`。它只接受 `cake-runtime-pg-*` 命名、网络模式为 `none` 且不映射端口的 Docker 容器，创建全新的 `cake_projection_*` 数据库；已有同名数据库会失败退出，不清空或覆盖。没有连接 Supabase 或调用外部业务服务的路径。

合并后的代码在仓库根目录执行一条命令：

```bash
python3 tests/biz/action-execution/verify-runtime-postgres.py \
  --container cake-runtime-pg-20261021 \
  --output /private/tmp/cake-runtime-cold-final
```

每次使用新的输出目录；数据库名默认含执行时间。输出目录保存实际加载的每份 SQL、执行日志、源文件 SHA-256、仓库提交和 PostgreSQL 版本。数据库保留供复查。若最终 D 提交尚未并入当前分支，可显式传 `--delivery-ref <本地提交SHA>`，只从该提交读取 `100000` 迁移和它的 SQL 测试；其他文件仍读当前工作树。`--baseline-only` 仅核验真实旧依赖，不代表新迁移已通过。

## 依赖来源

基础部分从 `20260310000000_baseline.sql` 原样提取序列及完整 `chat_messages`、`message_processing_records` 建表段。随后按顺序执行以下原迁移全文：

| 日期前缀                           | 真实依赖                                                   |
| ---------------------------------- | ---------------------------------------------------------- |
| `20260527120000`                   | 长期记忆原表、默认值、置信度合并函数                       |
| `20260529150000`                   | ops_events、daily_ops_report、upsert_ops_event、原预约指针 |
| `20260608120000`                   | 取消/改约计数列及原投影映射                                |
| `20260610120000 / 120100 / 130000` | 会话沉淀水位、标记函数、偏好列                             |
| `20260630120000`                   | active_booking 原列名迁移                                  |
| `20260707150000`                   | 原子档案/偏好写入函数                                      |
| `20260821210000`                   | 当前长期记忆列名与旧 RPC 实现                              |
| `20260825025701`                   | 账号维度约束、共享预约行唯一索引与账号版 RPC               |
| `20260825050239 / 055058 / 063752` | 摘要数组及工作水位、九字段档案 RPC、原 CAS 懒迁移          |
| `20260911120000`                   | 当前记忆形态约束与旧懒迁移函数退役                         |

唯一在本地提供的环境函数是 Supabase `auth.role()` 的 JWT 设置读取适配，以及三种角色。所有业务表、约束和 RPC 均来自真实迁移，尤其 `upsert_long_term_profile_facts` 与 `upsert_ops_event` 不使用 stub。

新增迁移顺序与依赖：

| 新迁移                                           | 直接依赖                                                       |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `20261021090000_agent_action_records.sql`        | PostgreSQL 与 Supabase 三种角色                                |
| `20261021093000_action_ops_event_projection.sql` | 旧 ops_events 结构和复合幂等唯一键                             |
| `20261021100000_reply_turns.sql`                 | `90000` 的动作表、证据及动作函数                               |
| `20261021110000_booking_poll_seek_index.sql`     | 旧 ops_events 的 report_date/id/event_name                     |
| `20261021130000_version_booking_projections.sql` | `90000`；当前长期记忆结构、账号/共享行唯一约束及真实原档案 RPC |

## 验证边界

入口执行现有 `action-records.postgres.sql`、`action-review.postgres.sql`、`booking-projection.postgres.sql`、`reply-turns.integration.sql`，并运行真实双会话并发资产 `action-records-concurrency.py` 和 `booking-projection-concurrency.py`。SQL 断言覆盖未知结果、fence/owner、迟到证据、人工确认、不可重发、回调匹配、原计划与本地投影版本/墓碑及新接口权限。并发检查使用两个实际数据库连接，不模拟锁。

新增 `action-ops-projection.integration.sql` 通过真实 `upsert_ops_event` 验证原时间、三类成功事件计数、幂等重放、进群结果白名单补充和跨企业隔离：补充元数据不改变原日期、正文或计数。所有业务数据均为脚本内合成值。

此核验是相关依赖链的冷启动验证，不是全部历史 Supabase 迁移演练，也不证明生产迁移或生产负载已验证。发布仍需执行仓库既有测试/生产迁移流程。

## 2026-10-21 验证结果

PostgreSQL 15 专用库 `cake_projection_runtime_final_20261021` 全部通过：14 份真实旧迁移、baseline 必需表原文、5 份新增迁移、5 份 SQL 故障/权限断言资产以及 2 份真实并发脚本。并发断言确认争抢只有一个 owner/fence，竞争后的取消不会把 executing 改成 cancelled；旧改约不能覆盖新版本、不同工单不丢更新、取消墓碑不会被旧补账复活。

实际执行的五份新增 SQL 的 SHA-256 均与集成提交 `7bf16a2f` 完全一致；D 迁移和测试从该本地 Git 提交读取。验证入口在 `codex/runtime-migration-validation` 的实际命令为：

```bash
python3 tests/biz/action-execution/verify-runtime-postgres.py \
  --container cake-runtime-pg-20261021 \
  --database cake_projection_runtime_final_20261021 \
  --delivery-ref 7bf16a2f \
  --output /private/tmp/cake-runtime-cold/final-result-20261021
```

重跑时需换新的数据库与输出目录，或使用前文自动数据库名的入口。日志与源文件清单位于输出目录，整轮日志为 `/private/tmp/cake-runtime-cold/final-run.log`。本轮未创建容器，只使用已隔离的根测试容器；没有清理或改写其他测试数据库。

索引依据沿用已完成的独立实验：[600,000 条合成事件的轮询分页对照](runtime-background-jobs-explain.md)确认最终两条 seek 范围均由部分索引限制，同日范围读取 38 行、后续日期只取 100 行，企业内 pass 查询使用既有复合唯一索引。[150,000 条合成事件的进群补充查询](runtime-action-ops-events.md)使用三个等值键的唯一索引，实际只锁 1 行。这些实验与本次冷启动测试分开执行，耗时不作为生产承诺。
