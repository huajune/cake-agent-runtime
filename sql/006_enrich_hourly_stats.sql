-- ============================================
-- 扩展 monitoring_hourly_stats 表
-- 新增 token、fallback、scenario、tool 聚合字段
-- 使 hourly stats 成为 Dashboard 历史查询的完整数据源
-- ============================================

ALTER TABLE monitoring_hourly_stats
  ADD COLUMN IF NOT EXISTS total_token_usage BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fallback_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fallback_success_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scenario_stats JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS tool_stats JSONB DEFAULT '{}';

COMMENT ON COLUMN monitoring_hourly_stats.total_token_usage IS '该小时 Token 消耗总量';
COMMENT ON COLUMN monitoring_hourly_stats.fallback_count IS '该小时降级次数';
COMMENT ON COLUMN monitoring_hourly_stats.fallback_success_count IS '该小时降级成功次数';
COMMENT ON COLUMN monitoring_hourly_stats.scenario_stats IS '场景分布统计 JSONB: {"greeting": {"count": 5, "success_count": 4, "avg_duration": 1200}}';
COMMENT ON COLUMN monitoring_hourly_stats.tool_stats IS '工具使用统计 JSONB: {"search_knowledge": 3, "create_booking": 1}';
