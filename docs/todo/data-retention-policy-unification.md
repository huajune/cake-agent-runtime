# 数据保留策略统一 + 消息趋势换源

- **所有者**：jiezhu（决策）/ Claude（执行）
- **状态**：已裁定，未实施
- **裁定日期**：2026-09-02
- **完成条件**：下列 A–D 全部落码并通过 `ci:check`；迁移随发版推入生产；`.env.example` 与本文一致；发版后核验清理任务按新阈值执行一次。

> **实施状态（2026-09-02）**：A / B / C / E1(回填+闭环列+序号) / E2 / E3 / E4 / E6 已在分支 `feat/data-retention-and-schema-audit` 落码并通过 `ci:check`；两条迁移已推 TEST 并烟测，**生产迁移未推，必须随本分支发版同步 `db:push:prod`**。D、E1 其余项、E5 其余项、「待核」未动。

## 裁定原则

> 业务 / 不可再生数据 → 永久；Agent 观测数据 → 统一 ≤ 90 天。
> 仪表盘是业务卡 + 观测卡混排：业务卡数据永久，观测卡少于 90 天就少，前端覆盖起点提示如实显示即可。

成本前提（2026-09-02 实测）：库 2.68 GB；Pro 方案含 8 GB 磁盘，超出 $0.125/GB·月。按本策略推算 +1 年 6.0 GB、+3 年 10.5 GB，三年累计超额费不足 $10。**存储不是约束**，账单由计算实例与出站流量决定。

## 每张表的结论

| 组 | 表 | 现状 | 结论 | 说明 |
| --- | --- | --- | --- | --- |
| 业务 / 不可再生 → 永久 | `chat_messages` | 100d | **永久** | 唯一不可再生；BadCase 复盘、评测集、语料、纠纷证据都依赖它 |
|  | `user_activity` | 365d | **永久** | 托管趋势数据源，属业务 |
|  | `ops_events` `daily_ops_report` `agent_long_term_memories` `candidate_blacklist` `user_hosting_status` | 永久 | 不动 | — |
| Agent 观测 → 90d | `message_processing_records` | 60d | **90d** | `agent_invocation` 仍 7d 置空 |
|  | `agent_execution_events` | 60d | **90d** | 跟随处理期 |
|  | `guardrail_review_records` | 60d | **90d** | 跟随处理期 |
|  | `monitoring_hourly_stats` | 永久 | **90d** | 新增清理；上游流水本就 90d |
|  | `monitoring_daily_stats` | 永久 | **90d** | 新增清理 |
|  | `monitoring_error_logs` | 30d | **90d** | 统一 |
|  | `handoff_events` | 永久 | **90d** | 新增清理；全部字段已在 `ops_events.payload` 永久留存，已验证 |
|  | `reengagement_touch_records` | 90d | 不动 | `generated_text` 仍 30d 置空 |
| 配置 / 测试 → 永久 | `strategy_config` `strategy_config_changelog` `system_config` `test_batches` `test_executions` `test_conversation_snapshots` | 永久 | 不动 | — |

## A. 清理任务改造（`src/biz/monitoring/services/cleanup/data-cleanup.service.ts`）

- [x] `DATA_CLEANUP_PROCESSING_DAYS` 默认 `60 → 90`（同时驱动 mpr / agent_execution_events / guardrail_review_records）
- [x] `DATA_CLEANUP_ERROR_LOGS_DAYS` 默认 `30 → 90` — 并入 `DATA_CLEANUP_PROCESSING_DAYS` 统一阈值（错误日志/统计表/转人工底账都跟它走）
- [x] 摘掉 `cleanupChatMessages()`、`cleanupUserActivity()` 及其配置项 `DATA_CLEANUP_CHAT_DAYS` / `DATA_CLEANUP_USER_ACTIVITY_DAYS`
- [x] 新增 `monitoring_hourly_stats` / `monitoring_daily_stats` / `handoff_events` 三个 90d 清理，仓储侧 `.delete().lt(...)` 直删，照 `error-log.repository.ts#cleanupErrorLogs` 写法，不新增 RPC
- [x] 保留 `nullAgentInvocations`（7d）与 `generated_text` 置空（30d）不动 — 子表拆分后改为先 `delete_expired_agent_invocations` 分批删子表，再 `null_agent_invocation` 置空存量主表列
- [x] 迁移：`DROP FUNCTION IF EXISTS cleanup_chat_messages(integer)`、`cleanup_user_activity(integer)`，关掉"改回配置就又开始删"的暗门
- [x] `tests/biz/monitoring/services/cleanup/data-cleanup.service.spec.ts` 同步：断言新阈值、断言 chat/user_activity 不再被调用、新增三张表的清理断言
- [x] `.env.example` 清理段同步；`docs/prompt-rule-ledger.md` 无涉（非 prompt 规则）
- [ ] 发版底账写明：观测表历史将从 04-15 截到 90 天，属预期

## B. 后台全部统计页面加「全部」档 + 消息趋势换源

> 2026-09-02 用户明确：「全部」是 web 后台**所有**统计相关页面的需求，不只是聊天记录页。
> 原则：业务指标走永久表 → 可真「全部」；观测指标最多 90 天 → 「全部」档下如实显示覆盖起点，不伪装完整。

- [x] 先盘点：逐页列出每个统计卡/图的数据源表与接口（仪表盘 / 托管用户 / 转化分析 / 运营日报 / 聊天记录 / 系统监控 / 二次触发追溯），标注「业务 / 观测」 — 盘点结论已落到各页改造项；系统监控/二次触发追溯纯观测不加档
- [x] **仪表盘**：时间档加「全部」；业务卡（托管用户数、预约成功、转化率）走 `user_activity` / `daily_ops_report` / `ops_events`；观测卡（请求数、成功率、响应、人工介入）在「全部」下按 90 天覆盖并显示起点 — `TimeRange` 加 `all`（起点 2026-01-01，环比窗口等长前一段，前端按 `dataCoverage` 隐藏环比）；缓存 300s；预热 6 档
- [x] **托管用户页**：档位 30/60/90 → 加「全部」；数据源 `user_activity` 已定永久，直接可用 — `days=0` = 全部，服务端上限 730 天
- [x] **转化分析 / 运营日报**：确认已走 `ops_events` / `daily_ops_report`，加「全部」；安全起点 **2026-06**（埋点齐全），更早只展示已上线埋点的指标并标注 — `ConversionRange` 加 `all`，`getPeriod` 自 2026-01-01 动态算天数
- [x] **聊天记录·消息趋势**：消息数改读 `daily_ops_report.candidate_message_count + agent_reply_count`（逻辑消息，不再计投递分段）；会话数改读 `ops_events` 按 `report_date` 的 `COUNT(DISTINCT chat_id)`（已验证工作日与真值吻合 92~99%）；加「全部」 — 新 RPC `get_chat_business_daily_trend(p_start_date, p_end_date)` + `get_business_data_floor()`，接口 `GET /analytics/chat-business-daily-trend`；面板标注口径与覆盖起点
- [x] **系统监控**：纯观测，最长档位就是 90 天，不加「全部」，界面说明保留期
- [ ] 与运营对齐口径：消息趋势数值约减半（不再重复计 AI 回复分段），是口径修正不是业务下滑
- [x] `get_chat_daily_stats` 保留给排障用，面板不再依赖 `chat_messages` 保留期
- [ ] 「全部」档的查询必须走聚合表 / DB 侧聚合，禁止前端拉明细；每个新档位上线前实测生产耗时

## C. 死取数清理

- [x] `analytics-dashboard.service.ts` 的 `dailyTrend` 字段：每次概览请求都从日聚合算一遍，前端从不渲染 → 删
- [x] `analytics-query.service.ts#getMetricsDataAsync` 的 `hourlyStats`：每 5 秒拉 72 行，系统监控页只用 `percentiles.p95` → 删
- [x] 同步删前端 `analytics.types.ts` 对应字段与 spec

## D. PII 读取路径收口（独立项，不阻塞 A–C）

- [ ] `chat_messages.content` / `candidate_name` 与 `daily_ops_report.candidate_summary` 目前 service role 全开；梳理 Dashboard 展示原文的入口，确认有权限控制
- [ ] 任何导出脚本禁止带出 `candidate_summary`

## E. 表结构与索引审计发现（2026-09-02，生产实测；独立于 A–D，可单独成 PR）

> 注意：`pg_stat_*` 扫描计数因实例 05:41 UTC 重启只覆盖 35 分钟，**不能**作为"索引没人用"的证据；下列结论全部来自数据形态 + 代码/迁移静态分析。

### E1. `handoff_events` —— 用户裁定：保留，定位是离线分析 Agent 运营状态的底账；按下列缺陷修复
> 2026-09-02 全表核验（1,562 行，06-05 起）。它目前只有 `insertHandoffEvent` 一个写入口、零读路径，转化分析已改读 `ops_events(handoff.triggered)`。要让它重新可用，先修数据质量，再把离线分析接回来。
- [x] **差 246 条 = 历史回填，不是实时漏记**（已核实：`ops_events(handoff.triggered)` 1,811 行里 233 条 payload 带 `source_table`、13 条带 `backfill`，合计 246，正好等于差值；`HandoffRecorderService.record()` 对两张表用同一 input 同一幂等键写入，实时路径一致）。修：一次性从 `ops_events.payload` 回填这 246 条到 `handoff_events`（幂等键沿用），之后两表行数应恒等，可作为对账断言 — 迁移 20260902073727 已从 `ops_events.payload` 回填（`missing_job_info` 原样搬 jsonb）
- [ ] **两个兜底原因码占 43%**：`system_blocked` 367 + `other` 304。离线分析最想看的"为什么转"有近一半落在筐里。修：把 `system_blocked` 按触发源（守卫拦截 / 工具失败 / 超时…）拆子码；`other` 强制带 `reason` 文本并定期归类回收
- [ ] **`work_order_id` 70% 为空、`job_id` 78% 为空**：先区分"本就无工单"和"漏记"——按 `reason_code` 分组看空值率，`modify_appointment` / `booking_conflict` 这类应 100% 有工单
- [ ] **`stage` 16% 为 NULL**（244 行）：转人工时会话阶段应总能取到，查写入点为何传空
- [x] **无结果 / 闭环列**：只记"触发了"，不记人工接手后怎么样（已处理 / 候选人流失 / 回到 Agent）。这是"转人工闭环率不可测"的根因。加 `outcome` + `resolved_at`，由人工介入/恢复托管事件回填 — 已加 `outcome` / `resolved_at`；`UserHostingService.resumeUser` 回填 `resumed`、定时到期解禁回填 `expired`（只更新 `outcome IS NULL` 的行）
- [x] **同一会话重复触发 206 个**：无 `first_handoff_id` / 序号，分析时分不清"反复转"和"新问题"。加会话内序号或关联首触发 — 已加 `sequence_no`（存量按 `created_at` 回填；新写入经 `next_handoff_sequence_no(corp_id, chat_id)` 取号）
- [ ] `missing_job_info` **已是结构化 jsonb 列表**（Top：发薪主体 27、签约主体 11、发薪日 10、发薪方式 8），不是自由文本——之前"缺口列是自由文本"的记忆有误，可直接 `jsonb_array_elements` 分组统计
- [ ] 7 个索引里 `idx_handoff_events_user_id` / `_corp_reason` / `_corp_stage` / `_job_id` 在本表零读路径下全部空转；离线分析接回后按实际查询重建，先不动

### E2. 死列 / 恒空列（全表验证）
- [x] ~~`message_processing_records.guardrail_input` 删列~~ — **保留**。复核写入路径：它记录的是**入站**（inbound）守卫拦截（`reply-workflow.service.ts` 仅在 `guardrailBlocked.phase === 'inbound'` 时写），`guardrail_review_records` 只覆盖出站；0.03% 是命中稀少，不是死列。`alert_type` / `is_fallback` 同理保留
- [x] `message_processing_records.ai_start_at` / `ai_end_at`：仓储外零引用，`ai_duration` 已足够 → 已删列 + 清实体/类型/映射（迁移 20260902073727）
- [x] `chat_messages.org_id`（2 个值）、`bot_id`（与 `im_bot_id` 重复）：已删列 + 清映射。**`is_room` 保留**：仓储按它过滤群消息（L53/L99），当前全 false 只是没有群消息
- [ ] `chat_messages.external_user_id`：14 天 62k 行只有 **8 个去重值**（≈bot 数），来源是群回调的 `groupCallback.externalUserId`，不是候选人标识 → 列名误导。改名要动入站解析链，本批不动，留待入站重构一并处理
- [x] `user_activity.group_id` / `group_name`：生产 21,318 行两列均 **0% 非空**，`saveUserActivity` 两处调用点从不传值 → 已删两列 + 重建 `upsert_user_activity` / `get_active_users_from_user_activity`（去掉 group 参数与返回列），前端 `groupName?` 可选字段本就永远为空、无需改

### E3. 单行 74 KB 的根因（`message_processing_records`）
- [ ] 新行平均 73.6 KB，其中 `agent_invocation` **59 KB（80%）**、`agent_steps` 7.3 KB、`tool_calls` 5.6 KB。每回合至少 3 个行版本：`recordMessageReceived` 瘦行 upsert → `persistTerminalState` 整行 upsert（此时才带 59 KB）→ `updateStatusByMessageId` / `updatePostProcessingStatus` 各一次；35 分钟内 531 插 / 649 更 / 312 删，**死元组 76.9%**
- [x] 方案：`agent_invocation` 拆到独立表（`message_processing_invocations`，PK=message_id），主表只留标量与轻 jsonb；7 天置空逻辑随之移到子表。副作用：所有宽投影读取自动瘦身，metrics/流水页再无 TOAST detoast 风险 — 已建 `message_processing_invocations`（PK=message_id，级联删除）；仓储写子表、详情投影 embed 优先/旧列兜底；7d 清理改 `delete_expired_agent_invocations`
- [x] 同理评估 `reengagement_touch_records`（死元组 59.9%，`events` 全轨迹 jsonb 原地累加）与 `agent_long_term_memories`（48.8%）的 UPDATE 频度；至少为这三张表设置 `autovacuum_vacuum_scale_factor=0.02` — 三张表已设 `autovacuum_vacuum_scale_factor=0.02`；UPDATE 频度评估留待观测

### E4. 无用 / 冗余索引（静态分析，建议 DROP）
| 索引 | 大小 | 依据 |
| --- | --- | --- |
| `idx_ops_events_corp_date_bot` (corp_id, report_date, bot_im_id) | 3.5 MB | 迁移里唯一匹配是 `daily_ops_report` 的 ON CONFLICT（另一张表）；`ops_events` 无任何按此组合的谓词 |
| `idx_agent_long_term_memories_updated_at` | 1.6 MB | 除 CREATE INDEX 外零引用 |
| `idx_agent_long_term_memories_user` (corp_id, user_id) | 1.5 MB | 是 `agent_long_term_memories_relation_unique` (corp_id, user_id, bot_user_id) 的前缀 |
| `idx_message_batch_id` WHERE batch_id IS NOT NULL | 8.1 MB | `batch_id` **99.9% 非空**，partial 条件形同虚设；`batch_id` 查询只在 debounce 合并路径，可评估是否需要索引 |
| `idx_reengagement_touch_session` (session_id) | 0.9 MB | 是 `idx_reengagement_touch_session_scenario_updated` 的前缀 |
| `idx_test_executions_batch_id` (batch_id) | 56 kB | 被 3 个 batch_id 前导的复合索引覆盖 |
| `monitoring_daily_stats_stat_date_key` + `idx_monitoring_daily_stats_stat_date` | 32 kB | 同列 unique + DESC 双索引，留 unique 即可 |
| `monitoring_hourly_stats_hour_key` + `idx_hourly_stats_hour` | 144 kB | 同上 |
| `test_executions` 上 3 个 gin (`execution_trace` / `memory_trace` / `source_trace`) | 10.7 MB | 表只 2,558 行，gin 比数据还大；确认查询是否真用 `@>`，否则 DROP |

**已执行（迁移 20260902073727）**：DROP 前 8 项（`idx_ops_events_corp_date_bot` / `idx_agent_long_term_memories_updated_at` / `idx_agent_long_term_memories_user` / `idx_message_batch_id` / `idx_reengagement_touch_session` / `idx_test_executions_batch_id` / `idx_monitoring_daily_stats_stat_date` / `idx_hourly_stats_hour`）。`test_executions` 3 个 gin 未动（先确认 `@>` 查询）。
**补建（迁移 20260902082559）**：`idx_ops_events_report_date_chat (report_date, chat_id)` —— 既有索引全部以 `corp_id` 打头，新 RPC 只按 `report_date` 过滤会退化成 165 MB 顺扫。

### E6. 顺手发现：仪表盘「小组」筛选一直是空集（已修）
- [x] `UserHostingRepository.findActiveChatIdsByGroups` 按 `user_activity.group_name IN (...)` 过滤，而该列从无写入者（0% 非空）→ 选任何小组，观测卡全为 0。修：小组先经 `BotGroupResolverService.listBotKeysByGroups()` 翻成该组 bot 的 wxid / wecomUserId（与转化分析页同源，Stride 动态表优先），再按 `user_activity.im_bot_id / bot_user_id` 过滤（两列各查一遍取并集）。`group_name` 列随 E2 删除。

### E5. 设计层面
- [x] ~~`daily_ops_report.candidate_summary` 移出聚合表~~ — **2026-09-02 用户裁定：不改。** 飞书运营日报 `ops-daily-report.cron.ts` 直接读该列写入「候选人基本信息」「报名明细」两个字段并做跨行 `mergeText`，改动会断日报。PII 风险改由 D 项（读取路径收口）承接
- [ ] `chat_messages` 一行 = 一个投递分段：传输产物混进内容表，导致「消息数」口径失真 2.2×；长期应加 `segment_index` / `logical_message_id` 或投递另记
- [x] `ops_events` 2 条 2023 / 2025 脏日期行：核实是真实 `interview.passed` 事件（`occurred_at` 来自海绵工单侧的脏时间戳），**不删**；已加 `CHECK (report_date >= '2026-01-01' AND <= CURRENT_DATE + 1) NOT VALID`，只拦新写入、不扫存量（迁移 20260902073727）
- [ ] 迁移里 `cleanup_message_processing_records` 定义了两次（默认 30 / 60）：保留一份
- [ ] `monitoring_error_logs` 与 `chat_messages` 同时有 `timestamp` 与 `created_at`：确认语义差异，否则去一列

## 待核（不改码，核完删本条）

- [ ] 复聊触达**结果**（`reengagement_touch_records.outcome_kind`）是否已作为业务事件进 `ops_events`；若未进，需补埋点后 90d 清理才不丢业务事实

## 已否决 / 不做

- ~~`chat_messages` 退回 60~90d~~ — 2026-09-02 否决，它是资产不是负债
- ~~`monitoring_*_stats` 因仪表盘长范围依赖而永久~~ — 2026-09-02 否决，观测数据少了就少，仪表盘业务卡不受影响
- PITR（$100/月/7 天）暂不开；等 `chat_messages` 体量有分量再评估
