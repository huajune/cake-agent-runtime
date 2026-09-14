# 数据保留策略统一 + 消息趋势换源（收尾项）

- **所有者**：jiezhu（决策）/ Claude（执行）
- **状态**：主体已随 v11.2.0 上线；迁移 `20260902073727` / `20260902082559` 已在生产。本文只剩下列收尾项
- **完成条件**：下列各项全部完成或明确否决后删除本文

## 裁定原则（已生效，勿再讨论）

> 业务 / 不可再生数据 → 永久；Agent 观测数据 → 统一 ≤ 90 天。
> 仪表盘业务卡永久，观测卡少于 90 天就少，前端如实显示覆盖起点。

各表阈值的唯一权威是 `src/biz/monitoring/services/cleanup/data-cleanup.service.ts` 的默认值与 `.env.example` 清理段。
永久：`chat_messages`、`user_activity`、`ops_events`、`daily_ops_report`、`agent_long_term_memories`、`candidate_blacklist`、`user_hosting_status`、配置/测试表。
90 天：`message_processing_records`（`agent_invocation` 子表 7 天）、`agent_execution_events`、`guardrail_review_records`、`monitoring_error_logs`、`monitoring_hourly_stats` / `monitoring_daily_stats`、`handoff_events`、`reengagement_touch_records`（`generated_text` 30 天置空）。

## 一、运营口径与生产核验

- [ ] 与运营对齐：聊天记录页「消息趋势」换源后数值约减半（逻辑消息，不再计投递分段），是口径修正不是业务下滑
- [ ] 核验清理任务已按新阈值跑过一轮：观测表历史从 04-15 截到 90 天属预期
- [ ] 各统计页「全部」档逐个实测生产耗时（必须走聚合表 / DB 侧聚合，禁止前端拉明细）

## 二、PII 读取路径收口

- [ ] `chat_messages.content` / `candidate_name` 与 `daily_ops_report.candidate_summary` 目前 service role 全开；梳理 Dashboard 展示原文的入口，确认有权限控制
- [ ] 任何导出脚本禁止带出 `candidate_summary`

`candidate_summary` 本身不移出聚合表（飞书运营日报直接读它），PII 风险由本节承接。

## 三、`handoff_events` 数据质量（离线分析底账，用户裁定保留）

- [ ] 兜底原因码占 43%（`system_blocked` 367 + `other` 304）：`system_blocked` 按触发源拆子码；`other` 强制带 `reason` 文本并定期归类回收
- [ ] `work_order_id` 70% 为空、`job_id` 78% 为空：按 `reason_code` 分组看空值率，区分「本就无工单」和「漏记」；`modify_appointment` / `booking_conflict` 应 100% 有工单
- [ ] `stage` 16% 为 NULL：查写入点为何传空
- [ ] `idx_handoff_events_user_id` / `_corp_reason` / `_corp_stage` / `_job_id` 在零读路径下空转；离线分析接回后按实际查询重建，接回前不动

`missing_job_info` 已是结构化 jsonb 列表，可直接 `jsonb_array_elements` 分组统计，不需要改表。

## 四、表结构遗留

- [ ] `chat_messages.external_user_id`：来源是群回调的 `groupCallback.externalUserId`，不是候选人标识，列名误导；随入站解析链重构一并改名
- [ ] `chat_messages` 一行 = 一个投递分段：长期应加 `segment_index` / `logical_message_id` 或投递另记，消除「消息数」2.2× 失真
- [ ] `test_executions` 上 3 个 gin 索引（`execution_trace` / `memory_trace` / `source_trace`，10.7 MB，表仅 2.5k 行）：确认查询是否真用 `@>`，否则 DROP
- [ ] 迁移里 `cleanup_message_processing_records` 定义了两次（默认 30 / 60）：保留一份
- [ ] `monitoring_error_logs` 与 `chat_messages` 同时有 `timestamp` 与 `created_at`：确认语义差异，否则去一列

## 五、待核（不改码，核完删本条）

- [ ] 复聊触达结果（`reengagement_touch_records.outcome_kind`）是否已作为业务事件进 `ops_events`；若未进，需补埋点后 90 天清理才不丢业务事实

## 已否决，勿再提

- `chat_messages` 退回 60~90 天：它是资产不是负债
- `monitoring_*_stats` 因仪表盘长范围依赖而永久：观测数据少了就少
- `daily_ops_report.candidate_summary` 移出聚合表：会断飞书日报
- PITR（$100/月/7 天）：等 `chat_messages` 体量有分量再评估
