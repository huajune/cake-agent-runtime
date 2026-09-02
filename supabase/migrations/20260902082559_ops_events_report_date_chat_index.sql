-- ops_events 按 report_date 的范围扫描没有索引支撑：既有索引全部以 corp_id 打头，
-- 而 get_chat_business_daily_trend / get_business_data_floor（20260902073727）只按 report_date 过滤，
-- 会退化成 165 MB 顺序扫描。补 (report_date, chat_id) 复合索引：范围扫 + 按日 COUNT(DISTINCT chat_id)
-- 可走 index-only；MIN(report_date) 直接取索引首项。
CREATE INDEX IF NOT EXISTS idx_ops_events_report_date_chat
  ON ops_events (report_date, chat_id);
