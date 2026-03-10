-- ============================================
-- Baseline Migration
-- Generated from production schema on 2026-03-10
-- Contains: 12 tables, 19 functions, indexes, RLS policies
-- ============================================

-- =====================================================
-- 1. Sequences
-- =====================================================

CREATE SEQUENCE IF NOT EXISTS user_activity_id_seq AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS message_processing_records_id_seq AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 NO CYCLE;

-- =====================================================
-- 2. Tables
-- =====================================================

-- 2.1 chat_messages - 用户与AI的聊天消息记录
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  chat_id text NOT NULL,
  message_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  timestamp timestamp with time zone NOT NULL,
  candidate_name text,
  manager_name text,
  org_id text,
  bot_id text,
  created_at timestamp with time zone DEFAULT now(),
  is_room boolean DEFAULT false,
  message_type text DEFAULT 'TEXT'::text,
  source text DEFAULT 'MOBILE_PUSH'::text,
  im_bot_id text,
  im_contact_id text,
  contact_type text DEFAULT 'UNKNOWN'::text,
  is_self boolean DEFAULT false,
  payload jsonb,
  avatar text,
  external_user_id text,
  CONSTRAINT chat_messages_pkey PRIMARY KEY (id),
  CONSTRAINT chat_messages_message_id_key UNIQUE (message_id)
);

COMMENT ON COLUMN chat_messages.chat_id IS '会话ID，通常为 recipientId';
COMMENT ON COLUMN chat_messages.message_id IS '消息唯一ID，用于去重';
COMMENT ON COLUMN chat_messages.role IS '消息角色：user=用户消息，assistant=AI回复';
COMMENT ON COLUMN chat_messages.content IS '消息内容';
COMMENT ON COLUMN chat_messages.timestamp IS '消息发送时间';
COMMENT ON COLUMN chat_messages.candidate_name IS '候选人微信昵称';
COMMENT ON COLUMN chat_messages.manager_name IS '招募经理姓名';
COMMENT ON COLUMN chat_messages.org_id IS '企业ID';
COMMENT ON COLUMN chat_messages.bot_id IS 'Bot ID';
COMMENT ON COLUMN chat_messages.is_room IS '是否群聊：false=私聊, true=群聊';
COMMENT ON COLUMN chat_messages.message_type IS '消息类型枚举: TEXT=文本, IMAGE=图片, VOICE=语音, FILE=文件, VIDEO=视频, LINK=链接等';
COMMENT ON COLUMN chat_messages.source IS '消息来源枚举: MOBILE_PUSH=手机推送, API_SEND=API发送, AI_REPLY=AI回复等';
COMMENT ON COLUMN chat_messages.im_bot_id IS '托管账号的系统 wxid';
COMMENT ON COLUMN chat_messages.im_contact_id IS '联系人系统ID（私聊时有值）';
COMMENT ON COLUMN chat_messages.contact_type IS '客户类型：UNKNOWN/PERSONAL_WECHAT/OFFICIAL_ACCOUNT/ENTERPRISE_WECHAT';
COMMENT ON COLUMN chat_messages.is_self IS '是否托管账号自己发送的消息';
COMMENT ON COLUMN chat_messages.payload IS '原始消息内容 JSON（保留完整 payload 供后续分析）';
COMMENT ON COLUMN chat_messages.avatar IS '用户头像URL';
COMMENT ON COLUMN chat_messages.external_user_id IS '企微外部用户ID';

-- 2.2 message_processing_records - 消息处理记录
CREATE TABLE IF NOT EXISTS message_processing_records (
  id bigint DEFAULT nextval('message_processing_records_id_seq'::regclass) NOT NULL,
  message_id text NOT NULL,
  chat_id text NOT NULL,
  user_id text,
  user_name text,
  manager_name text,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  message_preview text,
  reply_preview text,
  reply_segments integer DEFAULT 0,
  status text NOT NULL,
  error text,
  scenario text,
  total_duration integer,
  queue_duration integer,
  prep_duration integer,
  ai_start_at bigint,
  ai_end_at bigint,
  ai_duration integer,
  send_duration integer,
  tools text[],
  token_usage integer,
  is_fallback boolean DEFAULT false,
  fallback_success boolean,
  agent_invocation jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  batch_id character varying(255),
  is_primary boolean DEFAULT false,
  CONSTRAINT message_processing_records_pkey PRIMARY KEY (id),
  CONSTRAINT message_processing_records_message_id_key UNIQUE (message_id)
);

COMMENT ON COLUMN message_processing_records.total_duration IS '总耗时（毫秒）：从接收消息到发送完成的总时间';
COMMENT ON COLUMN message_processing_records.ai_duration IS 'AI处理耗时（毫秒）：Agent API 实际处理时间';
COMMENT ON COLUMN message_processing_records.agent_invocation IS '完整的 Agent 调用记录（JSONB）：request（发送的请求）、response（AI响应）、http（HTTP元信息）';
COMMENT ON COLUMN message_processing_records.batch_id IS '聚合批次ID，标识同一批聚合处理的消息';
COMMENT ON COLUMN message_processing_records.is_primary IS '是否为主消息（调用 Agent 的那条消息）';

-- 2.3 monitoring_hourly_stats - 小时级监控统计
CREATE TABLE IF NOT EXISTS monitoring_hourly_stats (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  hour timestamp with time zone NOT NULL,
  message_count integer DEFAULT 0 NOT NULL,
  success_count integer DEFAULT 0 NOT NULL,
  failure_count integer DEFAULT 0 NOT NULL,
  success_rate numeric DEFAULT 0,
  avg_duration integer DEFAULT 0,
  min_duration integer DEFAULT 0,
  max_duration integer DEFAULT 0,
  p50_duration integer DEFAULT 0,
  p95_duration integer DEFAULT 0,
  p99_duration integer DEFAULT 0,
  avg_ai_duration integer DEFAULT 0,
  avg_send_duration integer DEFAULT 0,
  active_users integer DEFAULT 0,
  active_chats integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  total_token_usage bigint DEFAULT 0,
  fallback_count integer DEFAULT 0,
  fallback_success_count integer DEFAULT 0,
  scenario_stats jsonb DEFAULT '{}'::jsonb,
  tool_stats jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT monitoring_hourly_stats_pkey PRIMARY KEY (id),
  CONSTRAINT monitoring_hourly_stats_hour_key UNIQUE (hour)
);

COMMENT ON COLUMN monitoring_hourly_stats.total_token_usage IS '该小时 Token 消耗总量';
COMMENT ON COLUMN monitoring_hourly_stats.fallback_count IS '该小时降级次数';
COMMENT ON COLUMN monitoring_hourly_stats.fallback_success_count IS '该小时降级成功次数';
COMMENT ON COLUMN monitoring_hourly_stats.scenario_stats IS '场景分布统计 JSONB';
COMMENT ON COLUMN monitoring_hourly_stats.tool_stats IS '工具使用统计 JSONB';

-- 2.4 monitoring_error_logs - 监控错误日志
CREATE TABLE IF NOT EXISTS monitoring_error_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  message_id text NOT NULL,
  timestamp bigint NOT NULL,
  error text NOT NULL,
  alert_type text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT monitoring_error_logs_pkey PRIMARY KEY (id)
);

-- 2.5 user_activity - 用户活跃度记录
CREATE TABLE IF NOT EXISTS user_activity (
  id bigint DEFAULT nextval('user_activity_id_seq'::regclass) NOT NULL,
  chat_id text NOT NULL,
  od_id text,
  od_name text,
  group_id text,
  group_name text,
  activity_date date NOT NULL,
  message_count integer DEFAULT 0,
  token_usage integer DEFAULT 0,
  first_active_at timestamp with time zone NOT NULL,
  last_active_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_activity_pkey PRIMARY KEY (id),
  CONSTRAINT user_activity_chat_id_activity_date_key UNIQUE (chat_id, activity_date)
);

COMMENT ON COLUMN user_activity.chat_id IS '会话ID，用户唯一标识';
COMMENT ON COLUMN user_activity.od_id IS '用户 OD ID';
COMMENT ON COLUMN user_activity.od_name IS '用户昵称';
COMMENT ON COLUMN user_activity.group_id IS '所属小组 ID';
COMMENT ON COLUMN user_activity.group_name IS '所属小组名称';
COMMENT ON COLUMN user_activity.activity_date IS '活跃日期（按天聚合）';
COMMENT ON COLUMN user_activity.message_count IS '当日消息数量';
COMMENT ON COLUMN user_activity.token_usage IS '当日 Token 消耗';
COMMENT ON COLUMN user_activity.first_active_at IS '当日首次活跃时间';
COMMENT ON COLUMN user_activity.last_active_at IS '当日最后活跃时间';

-- 2.6 user_hosting_status - 用户托管状态
CREATE TABLE IF NOT EXISTS user_hosting_status (
  user_id character varying(100) NOT NULL,
  is_paused boolean DEFAULT false,
  paused_at timestamp with time zone,
  resumed_at timestamp with time zone,
  pause_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_hosting_status_pkey PRIMARY KEY (user_id)
);

-- 2.7 system_config - 系统配置
CREATE TABLE IF NOT EXISTS system_config (
  key character varying(100) NOT NULL,
  value jsonb NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT system_config_pkey PRIMARY KEY (key)
);

-- 2.8 strategy_config - 策略配置
CREATE TABLE IF NOT EXISTS strategy_config (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text DEFAULT '默认策略'::text NOT NULL,
  description text,
  persona jsonb DEFAULT '{}'::jsonb NOT NULL,
  stage_goals jsonb DEFAULT '{}'::jsonb NOT NULL,
  red_lines jsonb DEFAULT '{}'::jsonb NOT NULL,
  industry_skills jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT strategy_config_pkey PRIMARY KEY (id)
);

-- 2.9 interview_booking_records - 面试预约记录
CREATE TABLE IF NOT EXISTS interview_booking_records (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  date date NOT NULL,
  brand_name text,
  store_name text,
  booking_count integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  chat_id character varying(255),
  user_id character varying(255),
  user_name character varying(255),
  manager_id character varying(255),
  manager_name character varying(255),
  CONSTRAINT booking_stats_pkey PRIMARY KEY (id),
  CONSTRAINT booking_stats_date_brand_name_store_name_key UNIQUE (date, brand_name, store_name)
);

COMMENT ON COLUMN interview_booking_records.date IS '预约日期';
COMMENT ON COLUMN interview_booking_records.brand_name IS '品牌名称';
COMMENT ON COLUMN interview_booking_records.store_name IS '门店名称';
COMMENT ON COLUMN interview_booking_records.booking_count IS '预约次数（通常为 1）';
COMMENT ON COLUMN interview_booking_records.chat_id IS '会话ID，用于关联消息记录';
COMMENT ON COLUMN interview_booking_records.user_id IS '用户的系统 wxid (imContactId)';
COMMENT ON COLUMN interview_booking_records.user_name IS '用户昵称 (contactName)';
COMMENT ON COLUMN interview_booking_records.manager_id IS '招募经理 ID (botUserId/imBotId)';
COMMENT ON COLUMN interview_booking_records.manager_name IS '招募经理昵称';

-- 2.10 test_batches - 测试批次
CREATE TABLE IF NOT EXISTS test_batches (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name character varying(200) NOT NULL,
  source character varying(50) DEFAULT 'manual'::character varying NOT NULL,
  feishu_app_token character varying(100),
  feishu_table_id character varying(100),
  total_cases integer DEFAULT 0,
  executed_count integer DEFAULT 0,
  passed_count integer DEFAULT 0,
  failed_count integer DEFAULT 0,
  pending_review_count integer DEFAULT 0,
  pass_rate numeric,
  avg_duration_ms integer,
  avg_token_usage integer,
  status character varying(20) DEFAULT 'created'::character varying,
  created_by character varying(100),
  created_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  test_type character varying(50) DEFAULT 'scenario'::character varying,
  CONSTRAINT test_batches_pkey PRIMARY KEY (id)
);

COMMENT ON COLUMN test_batches.test_type IS '测试类型: scenario(场景测试) | conversation(对话验证)';

-- 2.11 test_executions - 测试执行记录
CREATE TABLE IF NOT EXISTS test_executions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  batch_id uuid,
  case_id character varying(100),
  case_name character varying(500),
  category character varying(100),
  test_input jsonb NOT NULL,
  expected_output text,
  agent_request jsonb,
  agent_response jsonb,
  actual_output text,
  tool_calls jsonb,
  execution_status character varying(20) DEFAULT 'pending'::character varying,
  duration_ms integer,
  token_usage jsonb,
  error_message text,
  review_status character varying(20) DEFAULT 'pending'::character varying,
  review_comment text,
  reviewed_by character varying(100),
  reviewed_at timestamp with time zone,
  failure_reason character varying(100),
  created_at timestamp with time zone DEFAULT now(),
  test_scenario character varying(100),
  conversation_source_id uuid,
  turn_number integer,
  similarity_score numeric,
  input_message text,
  evaluation_reason text,
  CONSTRAINT test_executions_pkey PRIMARY KEY (id)
);

COMMENT ON COLUMN test_executions.test_scenario IS '测试场景分类，用于飞书回写的分类字段';
COMMENT ON COLUMN test_executions.conversation_source_id IS '关联的对话源ID（对话验证类型使用）';
COMMENT ON COLUMN test_executions.turn_number IS '轮次编号（从1开始，对话验证类型使用）';
COMMENT ON COLUMN test_executions.similarity_score IS '语义相似度分数(0-100)';
COMMENT ON COLUMN test_executions.input_message IS '当前轮次的用户输入消息';
COMMENT ON COLUMN test_executions.evaluation_reason IS 'LLM 评估理由，说明为什么给出该评分';

-- 2.12 conversation_test_sources - 对话测试数据源
CREATE TABLE IF NOT EXISTS conversation_test_sources (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  batch_id uuid NOT NULL,
  feishu_record_id character varying(100) NOT NULL,
  conversation_id character varying(100) NOT NULL,
  participant_name character varying(200),
  full_conversation jsonb NOT NULL,
  raw_text text,
  total_turns integer DEFAULT 0 NOT NULL,
  avg_similarity_score numeric,
  min_similarity_score numeric,
  status character varying(50) DEFAULT 'pending'::character varying,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT conversation_test_sources_pkey PRIMARY KEY (id)
);

COMMENT ON COLUMN conversation_test_sources.batch_id IS '关联的测试批次ID';
COMMENT ON COLUMN conversation_test_sources.feishu_record_id IS '飞书表格记录ID';
COMMENT ON COLUMN conversation_test_sources.conversation_id IS '对话唯一标识（用于关联同一对话的多轮执行）';
COMMENT ON COLUMN conversation_test_sources.participant_name IS '候选人/用户名称';
COMMENT ON COLUMN conversation_test_sources.full_conversation IS '解析后的完整对话内容（JSON数组格式）';
COMMENT ON COLUMN conversation_test_sources.raw_text IS '原始对话文本（含时间戳）';
COMMENT ON COLUMN conversation_test_sources.total_turns IS '对话总轮数';
COMMENT ON COLUMN conversation_test_sources.avg_similarity_score IS '所有轮次的平均相似度分数(0-100)';
COMMENT ON COLUMN conversation_test_sources.min_similarity_score IS '所有轮次的最低相似度分数(0-100)';
COMMENT ON COLUMN conversation_test_sources.status IS '执行状态: pending(待执行)/running(执行中)/completed(已完成)/failed(失败)';

-- =====================================================
-- 3. Indexes
-- =====================================================

-- chat_messages indexes
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages USING btree (timestamp DESC);

-- message_processing_records indexes
CREATE INDEX IF NOT EXISTS idx_message_processing_received_at ON message_processing_records USING btree (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_processing_received_status ON message_processing_records USING btree (received_at DESC, status);
CREATE INDEX IF NOT EXISTS idx_message_batch_id ON message_processing_records USING btree (batch_id) WHERE (batch_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_message_batch_primary ON message_processing_records USING btree (batch_id, is_primary) WHERE (batch_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_message_is_primary ON message_processing_records USING btree (is_primary) WHERE (is_primary = true);

-- monitoring_error_logs indexes
CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON monitoring_error_logs USING btree (timestamp DESC);

-- monitoring_hourly_stats indexes
CREATE INDEX IF NOT EXISTS idx_hourly_stats_hour ON monitoring_hourly_stats USING btree (hour DESC);

-- interview_booking_records indexes
CREATE INDEX IF NOT EXISTS idx_booking_stats_date ON interview_booking_records USING btree (date);
CREATE INDEX IF NOT EXISTS idx_booking_stats_brand ON interview_booking_records USING btree (brand_name);
CREATE INDEX IF NOT EXISTS idx_interview_booking_date ON interview_booking_records USING btree (date);
CREATE INDEX IF NOT EXISTS idx_interview_booking_brand ON interview_booking_records USING btree (brand_name) WHERE (brand_name IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_interview_booking_user_id ON interview_booking_records USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_interview_booking_manager_id ON interview_booking_records USING btree (manager_id) WHERE (manager_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_interview_booking_date_manager ON interview_booking_records USING btree (date, manager_id) WHERE (manager_id IS NOT NULL);

-- strategy_config indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_config_active ON strategy_config USING btree (is_active) WHERE (is_active = true);

-- test_batches indexes
CREATE INDEX IF NOT EXISTS idx_test_batches_status ON test_batches USING btree (status);
CREATE INDEX IF NOT EXISTS idx_test_batches_test_type ON test_batches USING btree (test_type);
CREATE INDEX IF NOT EXISTS idx_test_batches_created_at ON test_batches USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_batches_type_created ON test_batches USING btree (test_type, created_at DESC);

-- test_executions indexes
CREATE INDEX IF NOT EXISTS idx_test_executions_batch_id ON test_executions USING btree (batch_id);
CREATE INDEX IF NOT EXISTS idx_test_executions_execution_status ON test_executions USING btree (execution_status);
CREATE INDEX IF NOT EXISTS idx_test_executions_review_status ON test_executions USING btree (review_status);
CREATE INDEX IF NOT EXISTS idx_test_executions_category ON test_executions USING btree (category);
CREATE INDEX IF NOT EXISTS idx_test_executions_created_at ON test_executions USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_executions_batch_exec_status ON test_executions USING btree (batch_id, execution_status);
CREATE INDEX IF NOT EXISTS idx_test_executions_batch_review ON test_executions USING btree (batch_id, review_status);
CREATE INDEX IF NOT EXISTS idx_test_executions_batch_created ON test_executions USING btree (batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_test_executions_conversation_source ON test_executions USING btree (conversation_source_id);
CREATE INDEX IF NOT EXISTS idx_test_executions_conv_turn ON test_executions USING btree (conversation_source_id, turn_number) WHERE (conversation_source_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_test_executions_turn_number ON test_executions USING btree (turn_number) WHERE (turn_number IS NOT NULL);

-- conversation_test_sources indexes
CREATE INDEX IF NOT EXISTS idx_conversation_sources_batch_id ON conversation_test_sources USING btree (batch_id);
CREATE INDEX IF NOT EXISTS idx_conversation_sources_status ON conversation_test_sources USING btree (status);
CREATE INDEX IF NOT EXISTS idx_conversation_sources_batch_status ON conversation_test_sources USING btree (batch_id, status);

-- =====================================================
-- 4. Trigger Functions
-- =====================================================

CREATE OR REPLACE FUNCTION update_message_processing_records_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_strategy_config_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_conversation_sources_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- =====================================================
-- 5. Triggers
-- =====================================================

CREATE TRIGGER trigger_update_message_processing_records_updated_at
  BEFORE UPDATE ON message_processing_records
  FOR EACH ROW EXECUTE FUNCTION update_message_processing_records_updated_at();

CREATE TRIGGER trigger_update_strategy_config_updated_at
  BEFORE UPDATE ON strategy_config
  FOR EACH ROW EXECUTE FUNCTION update_strategy_config_updated_at();

CREATE TRIGGER trigger_conversation_sources_updated_at
  BEFORE UPDATE ON conversation_test_sources
  FOR EACH ROW EXECUTE FUNCTION update_conversation_sources_updated_at();

-- =====================================================
-- 6. RPC Functions - Cleanup
-- =====================================================

CREATE OR REPLACE FUNCTION cleanup_chat_messages(retention_days integer DEFAULT 90)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM chat_messages
  WHERE timestamp < NOW() - (retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_message_processing_records(days_to_keep integer DEFAULT 30)
RETURNS TABLE(deleted_count bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff_date TIMESTAMPTZ;
  result_count BIGINT;
BEGIN
  cutoff_date := NOW() - (days_to_keep || ' days')::INTERVAL;
  DELETE FROM message_processing_records
  WHERE received_at < cutoff_date;
  GET DIAGNOSTICS result_count = ROW_COUNT;
  RETURN QUERY SELECT result_count;
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_user_activity(retention_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM user_activity
  WHERE activity_date < (NOW() AT TIME ZONE 'Asia/Shanghai')::DATE - retention_days;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

CREATE OR REPLACE FUNCTION null_agent_invocation(p_days_old integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE message_processing_records
  SET agent_invocation = NULL
  WHERE received_at < NOW() - (p_days_old || ' days')::interval
    AND agent_invocation IS NOT NULL;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- =====================================================
-- 7. RPC Functions - Query
-- =====================================================

CREATE OR REPLACE FUNCTION get_distinct_chat_ids()
RETURNS TABLE(chat_id text)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT cm.chat_id
  FROM chat_messages cm
  ORDER BY cm.chat_id ASC;
$$;

CREATE OR REPLACE FUNCTION get_chat_session_list(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  chat_id text,
  candidate_name text,
  manager_name text,
  message_count bigint,
  last_message text,
  last_timestamp timestamp with time zone,
  avatar text,
  contact_type text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH user_messages AS (
    SELECT DISTINCT ON (cm.chat_id)
      cm.chat_id,
      cm.candidate_name,
      cm.avatar,
      cm.contact_type
    FROM chat_messages cm
    WHERE cm.role = 'user'
      AND cm.timestamp >= p_start_date
      AND cm.timestamp <= p_end_date
    ORDER BY cm.chat_id, cm.timestamp DESC
  ),
  latest_messages AS (
    SELECT DISTINCT ON (cm.chat_id)
      cm.chat_id,
      cm.content,
      cm.timestamp
    FROM chat_messages cm
    WHERE cm.timestamp >= p_start_date
      AND cm.timestamp <= p_end_date
    ORDER BY cm.chat_id, cm.timestamp DESC
  ),
  aggregated_data AS (
    SELECT
      cm.chat_id,
      MAX(cm.manager_name) as manager_name,
      COUNT(*) as message_count
    FROM chat_messages cm
    WHERE cm.timestamp >= p_start_date
      AND cm.timestamp <= p_end_date
    GROUP BY cm.chat_id
  )
  SELECT
    ad.chat_id,
    COALESCE(um.candidate_name, '') as candidate_name,
    COALESCE(ad.manager_name, '') as manager_name,
    ad.message_count,
    CASE
      WHEN LENGTH(lm.content) > 50
      THEN SUBSTRING(lm.content FROM 1 FOR 50) || '...'
      ELSE COALESCE(lm.content, '')
    END as last_message,
    lm.timestamp as last_timestamp,
    COALESCE(um.avatar, '') as avatar,
    COALESCE(um.contact_type, '') as contact_type
  FROM aggregated_data ad
  LEFT JOIN user_messages um ON ad.chat_id = um.chat_id
  LEFT JOIN latest_messages lm ON ad.chat_id = lm.chat_id
  ORDER BY lm.timestamp DESC;
END;
$$;

CREATE OR REPLACE FUNCTION get_chat_daily_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(date date, message_count bigint, session_count bigint)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE(timestamp) as date,
    COUNT(*) as message_count,
    COUNT(DISTINCT chat_id) as session_count
  FROM chat_messages
  WHERE timestamp >= p_start_date
    AND timestamp <= p_end_date
  GROUP BY DATE(timestamp)
  ORDER BY date ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_chat_summary_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(total_sessions bigint, total_messages bigint, active_sessions bigint)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(DISTINCT chat_id) as total_sessions,
    COUNT(*) as total_messages,
    COUNT(DISTINCT CASE
      WHEN timestamp > (NOW() - INTERVAL '1 hour')
      THEN chat_id
      ELSE NULL
    END) as active_sessions
  FROM chat_messages
  WHERE timestamp >= p_start_date
    AND timestamp <= p_end_date;
END;
$$;

-- =====================================================
-- 8. RPC Functions - Dashboard
-- =====================================================

CREATE OR REPLACE FUNCTION get_dashboard_overview_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  total_messages bigint,
  success_count bigint,
  failure_count bigint,
  success_rate numeric,
  avg_duration numeric,
  active_users bigint,
  active_chats bigint,
  total_token_usage bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::bigint as total_messages,
    COUNT(*) FILTER (WHERE status = 'success')::bigint as success_count,
    COUNT(*) FILTER (WHERE status != 'success')::bigint as failure_count,
    ROUND(
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END, 2
    ) as success_rate,
    ROUND(COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL AND total_duration > 0), 0), 0) as avg_duration,
    COUNT(DISTINCT user_id)::bigint as active_users,
    COUNT(DISTINCT chat_id)::bigint as active_chats,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint as total_token_usage
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_fallback_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  fallback_total bigint,
  fallback_success bigint,
  fallback_success_rate numeric,
  fallback_affected_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE m.is_fallback = true)::bigint as fallback_total,
    COUNT(*) FILTER (WHERE m.is_fallback = true AND m.fallback_success = true)::bigint as fallback_success,
    ROUND(
      CASE
        WHEN COUNT(*) FILTER (WHERE m.is_fallback = true) > 0
        THEN (COUNT(*) FILTER (WHERE m.is_fallback = true AND m.fallback_success = true)::numeric
              / COUNT(*) FILTER (WHERE m.is_fallback = true)::numeric) * 100
        ELSE 0
      END, 2
    ) as fallback_success_rate,
    COUNT(DISTINCT m.user_id) FILTER (WHERE m.is_fallback = true)::bigint as fallback_affected_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_hourly_trend(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  hour timestamp with time zone,
  message_count bigint,
  success_count bigint,
  avg_duration numeric,
  token_usage bigint,
  unique_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('hour', m.received_at) as hour,
    COUNT(*)::bigint as message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint as success_count,
    ROUND(COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0), 0) as avg_duration,
    COALESCE(SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL), 0)::bigint as token_usage,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY date_trunc('hour', m.received_at)
  ORDER BY hour ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_minute_trend(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone,
  p_interval_minutes integer DEFAULT 5
)
RETURNS TABLE(
  minute timestamp with time zone,
  message_count bigint,
  success_count bigint,
  avg_duration numeric,
  unique_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('minute', m.received_at) -
      (EXTRACT(minute FROM m.received_at)::int % p_interval_minutes) * interval '1 minute' as minute,
    COUNT(*)::bigint as message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint as success_count,
    ROUND(COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0), 0) as avg_duration,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY date_trunc('minute', m.received_at) -
      (EXTRACT(minute FROM m.received_at)::int % p_interval_minutes) * interval '1 minute'
  ORDER BY minute ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_daily_trend(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  date date,
  message_count bigint,
  success_count bigint,
  avg_duration numeric,
  token_usage bigint,
  unique_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE(m.received_at) as date,
    COUNT(*)::bigint as message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint as success_count,
    ROUND(COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0), 0) as avg_duration,
    COALESCE(SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL), 0)::bigint as token_usage,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY DATE(m.received_at)
  ORDER BY date ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_scenario_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  scenario text,
  count bigint,
  success_count bigint,
  avg_duration numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(m.scenario, 'unknown') as scenario,
    COUNT(*)::bigint as count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint as success_count,
    ROUND(COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL), 0), 0) as avg_duration
  FROM message_processing_records m
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
  GROUP BY m.scenario
  ORDER BY count DESC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_tool_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  tool_name text,
  use_count bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    tool as tool_name,
    COUNT(*)::bigint as use_count
  FROM message_processing_records,
       unnest(tools) as tool
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
    AND tools IS NOT NULL
    AND array_length(tools, 1) > 0
  GROUP BY tool
  ORDER BY use_count DESC;
END;
$$;

-- =====================================================
-- 9. RPC Functions - Aggregation
-- =====================================================

CREATE OR REPLACE FUNCTION aggregate_hourly_stats(
  p_hour_start timestamp with time zone,
  p_hour_end timestamp with time zone
)
RETURNS TABLE(
  message_count bigint,
  success_count bigint,
  failure_count bigint,
  success_rate numeric,
  avg_duration numeric,
  min_duration numeric,
  max_duration numeric,
  p50_duration numeric,
  p95_duration numeric,
  p99_duration numeric,
  avg_ai_duration numeric,
  avg_send_duration numeric,
  active_users bigint,
  active_chats bigint,
  total_token_usage bigint,
  fallback_count bigint,
  fallback_success_count bigint,
  scenario_stats jsonb,
  tool_stats jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT *
    FROM message_processing_records m
    WHERE m.received_at >= p_hour_start
      AND m.received_at < p_hour_end
  ),
  duration_stats AS (
    SELECT
      COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY b.total_duration), 0) AS p50,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY b.total_duration), 0) AS p95,
      COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY b.total_duration), 0) AS p99
    FROM base b
    WHERE b.status = 'success'
      AND b.total_duration IS NOT NULL
      AND b.total_duration > 0
  ),
  scenario_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(
        sub.scenario_name,
        jsonb_build_object(
          'count', sub.cnt,
          'successCount', sub.succ,
          'avgDuration', sub.avg_dur
        )
      ),
      '{}'::jsonb
    ) AS stats
    FROM (
      SELECT
        COALESCE(b.scenario, 'unknown') AS scenario_name,
        COUNT(*)::int AS cnt,
        COUNT(*) FILTER (WHERE b.status = 'success')::int AS succ,
        ROUND(COALESCE(AVG(b.total_duration) FILTER (WHERE b.total_duration > 0), 0))::int AS avg_dur
      FROM base b
      GROUP BY COALESCE(b.scenario, 'unknown')
    ) sub
  ),
  tool_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(sub.tool_name, sub.tool_count),
      '{}'::jsonb
    ) AS stats
    FROM (
      SELECT
        unnest(b.tools) AS tool_name,
        COUNT(*)::int AS tool_count
      FROM base b
      WHERE b.tools IS NOT NULL
        AND array_length(b.tools, 1) > 0
      GROUP BY unnest(b.tools)
    ) sub
  )
  SELECT
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE b.status = 'success')::bigint AS success_count,
    COUNT(*) FILTER (WHERE b.status != 'success')::bigint AS failure_count,
    ROUND(
      CASE WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE b.status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END, 2
    ) AS success_rate,
    ROUND(COALESCE(AVG(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0)) AS avg_duration,
    ROUND(COALESCE(MIN(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0)) AS min_duration,
    ROUND(COALESCE(MAX(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0)) AS max_duration,
    ROUND(ds.p50) AS p50_duration,
    ROUND(ds.p95) AS p95_duration,
    ROUND(ds.p99) AS p99_duration,
    ROUND(COALESCE(AVG(b.ai_duration) FILTER (WHERE b.status = 'success' AND b.ai_duration > 0), 0)) AS avg_ai_duration,
    ROUND(COALESCE(AVG(b.send_duration) FILTER (WHERE b.status = 'success' AND b.send_duration > 0), 0)) AS avg_send_duration,
    COUNT(DISTINCT b.user_id)::bigint AS active_users,
    COUNT(DISTINCT b.chat_id)::bigint AS active_chats,
    COALESCE(SUM(b.token_usage) FILTER (WHERE b.token_usage IS NOT NULL), 0)::bigint AS total_token_usage,
    COUNT(*) FILTER (WHERE b.is_fallback = true)::bigint AS fallback_count,
    COUNT(*) FILTER (WHERE b.is_fallback = true AND b.fallback_success = true)::bigint AS fallback_success_count,
    sa.stats AS scenario_stats,
    ta.stats AS tool_stats
  FROM base b
  CROSS JOIN duration_stats ds
  CROSS JOIN scenario_agg sa
  CROSS JOIN tool_agg ta
  GROUP BY ds.p50, ds.p95, ds.p99, sa.stats, ta.stats;
END;
$$;

-- =====================================================
-- 10. Row Level Security (RLS)
-- =====================================================

-- chat_messages
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON chat_messages AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON chat_messages AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON chat_messages AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON chat_messages AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- message_processing_records
ALTER TABLE message_processing_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON message_processing_records AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON message_processing_records AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON message_processing_records AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON message_processing_records AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- monitoring_hourly_stats
ALTER TABLE monitoring_hourly_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON monitoring_hourly_stats AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON monitoring_hourly_stats AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON monitoring_hourly_stats AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON monitoring_hourly_stats AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- monitoring_error_logs
ALTER TABLE monitoring_error_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON monitoring_error_logs AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON monitoring_error_logs AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON monitoring_error_logs AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON monitoring_error_logs AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- user_activity
ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON user_activity AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON user_activity AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON user_activity AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON user_activity AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- user_hosting_status
ALTER TABLE user_hosting_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON user_hosting_status AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON user_hosting_status AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON user_hosting_status AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON user_hosting_status AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- system_config
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON system_config AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON system_config AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON system_config AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON system_config AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- strategy_config
ALTER TABLE strategy_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_read_only" ON strategy_config AS PERMISSIVE FOR SELECT TO anon USING (true);
CREATE POLICY "service_role_full_access" ON strategy_config AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- interview_booking_records
ALTER TABLE interview_booking_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON interview_booking_records AS PERMISSIVE FOR ALL TO public USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));

-- test_batches
ALTER TABLE test_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON test_batches AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON test_batches AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON test_batches AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON test_batches AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- test_executions
ALTER TABLE test_executions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON test_executions AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON test_executions AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON test_executions AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON test_executions AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));

-- conversation_test_sources
ALTER TABLE conversation_test_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read" ON conversation_test_sources AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Service role insert" ON conversation_test_sources AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role update" ON conversation_test_sources AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
CREATE POLICY "Service role delete" ON conversation_test_sources AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
