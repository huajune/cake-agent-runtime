-- ============================================
-- 监控错误日志表
-- 用于存储消息处理过程中的错误记录
-- ============================================

-- 创建表
CREATE TABLE IF NOT EXISTS monitoring_error_logs (
  id BIGSERIAL PRIMARY KEY,

  -- 错误信息
  message_id TEXT,                             -- 关联消息ID
  timestamp BIGINT NOT NULL,                   -- Unix 毫秒时间戳
  error TEXT,                                  -- 错误描述
  alert_type TEXT,                             -- 告警类型

  -- 系统字段
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 索引：按时间戳降序查询（Dashboard 展示 + 清理）
CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp
  ON monitoring_error_logs(timestamp DESC);

-- 注释
COMMENT ON TABLE monitoring_error_logs IS '监控错误日志，记录消息处理中的异常';
COMMENT ON COLUMN monitoring_error_logs.message_id IS '关联的消息ID';
COMMENT ON COLUMN monitoring_error_logs.timestamp IS '错误发生时间（Unix 毫秒时间戳）';
COMMENT ON COLUMN monitoring_error_logs.error IS '错误描述信息';
COMMENT ON COLUMN monitoring_error_logs.alert_type IS '告警类型';

-- ============================================
-- RLS 策略 (Row Level Security)
-- ============================================

ALTER TABLE monitoring_error_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" ON monitoring_error_logs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Allow anonymous read access" ON monitoring_error_logs
  FOR SELECT
  USING (true);

-- ============================================
-- 清理函数
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_error_logs(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
  cutoff_timestamp BIGINT;
BEGIN
  -- 计算截止时间戳（Unix 毫秒）
  cutoff_timestamp := EXTRACT(EPOCH FROM (NOW() - (retention_days || ' days')::INTERVAL)) * 1000;

  DELETE FROM monitoring_error_logs
  WHERE timestamp < cutoff_timestamp;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_error_logs IS '清理指定天数前的错误日志，默认保留 30 天';
