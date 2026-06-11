-- 废弃 recruitment_cases 表（P2-3 收尾）。
--
-- 状态机（active/handoff/closed/expired）早已被新架构架空：
--   - 预约指针迁到 agent_long_term_memories.latest_booking
--   - handoff 触发分析迁到 handoff_events + ops_events.handoff.triggered
--   - 运行时托管状态由 user_hosting_status 的 pause/resume 一层表达
-- 应用侧 RecruitmentCaseService / RecruitmentStageResolverService 及
-- onboard-followup 通知链路均为零调用方死代码，已随本次重构删除。
-- 生产表 277 行，最后写入 2026-06-05（latest_booking 迁移当天）后零写入。

DROP TABLE IF EXISTS recruitment_cases CASCADE;
