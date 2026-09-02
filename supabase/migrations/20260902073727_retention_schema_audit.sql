-- 数据保留策略统一 + 表结构审计落地（docs/todo/data-retention-policy-unification.md A/B/E）
--
-- 裁定：业务 / 不可再生数据永久；Agent 观测数据统一 ≤90 天。
-- 本迁移只做元数据级或小体量操作，避免在 Micro 实例上触发大规模重写：
--   * DROP COLUMN / DROP INDEX / ALTER SET 均为 O(1) 元数据操作
--   * 新表 message_processing_invocations 不回填历史（旧行的 agent_invocation 由 7d 置空任务自然清空）
--   * handoff_events 回填 246 行为小体量 INSERT … SELECT
--   * ops_events 的 CHECK 用 NOT VALID：只约束新写入，不扫描存量

-- ============================================================
-- A. 清理策略：退役"永久表"的清理 RPC，关掉配置误改就重新开删的暗门
-- ============================================================
DROP FUNCTION IF EXISTS cleanup_chat_messages(integer);
DROP FUNCTION IF EXISTS cleanup_user_activity(integer);

-- 观测表的删除走仓储侧 .delete().lt()（同 monitoring_error_logs 既有做法），不新增 RPC。

-- ============================================================
-- E3. agent_invocation 拆出主表：59 KB / 行的 jsonb 与高频更新的标量分开住
-- ============================================================
-- 主表每回合至少 3 个行版本（瘦行 upsert → 整行 upsert → 2 次状态 update），
-- 每次都拖着 59 KB TOAST 复制，死元组 77%。拆出后主表行 ~15 KB，宽列读取不再 detoast。
CREATE TABLE IF NOT EXISTS message_processing_invocations (
  message_id       text PRIMARY KEY
                   REFERENCES message_processing_records(message_id) ON DELETE CASCADE,
  agent_invocation jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE message_processing_invocations IS
  '回合完整请求/响应快照（request / response / isFallback），1:0..1 挂在 message_processing_records 上。'
  '只在回合终态写一次；7 天后由 delete_expired_agent_invocations 删除。主表 agent_invocation 列仅存量兼容。';

CREATE INDEX IF NOT EXISTS idx_mp_invocations_created_at
  ON message_processing_invocations (created_at);

-- 7 天清理：新表按 created_at 删除；主表旧列继续置空直到存量耗尽（两者并行，各自幂等）
CREATE OR REPLACE FUNCTION delete_expired_agent_invocations(
  p_days_old integer DEFAULT 7,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM message_processing_invocations
  WHERE message_id IN (
    SELECT message_id FROM message_processing_invocations
    WHERE created_at < now() - (p_days_old || ' days')::interval
    ORDER BY created_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
COMMENT ON FUNCTION delete_expired_agent_invocations(integer, integer) IS
  '分批删除超过保留期的回合快照；与 null_agent_invocation（主表存量列）并行运行。';

-- 三张高更新表：默认 20% 才触发 autovacuum，对 74 KB / 行的表等于攒到几百 MB 尸体才清
ALTER TABLE message_processing_records
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE reengagement_touch_records
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE agent_long_term_memories
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

-- ============================================================
-- E2. 死列 / 恒空列（全表验证：非空率 ≤0.03% 或代码零引用）
-- ============================================================
-- guardrail_input 保留：它是入站（inbound）守卫拦截的唯一记录，guardrail_review_records 只覆盖出站；
-- 0.03% 非空是命中稀少，不是死列。
ALTER TABLE message_processing_records
  DROP COLUMN IF EXISTS ai_start_at,       -- 仓储外零引用；ai_duration 已足够
  DROP COLUMN IF EXISTS ai_end_at;

ALTER TABLE chat_messages
  DROP COLUMN IF EXISTS org_id,            -- 2 个值，仓储外零引用
  DROP COLUMN IF EXISTS bot_id;            -- 与 im_bot_id 重复，仓储外零引用
-- is_room 保留：仓储按它过滤群消息（虽然当前全为 false）。external_user_id 保留：改名/删除需动入站解析。

-- user_activity.group_id / group_name：生产 21,318 行两列均 0% 非空，两处写入点从不传值
ALTER TABLE user_activity
  DROP COLUMN IF EXISTS group_id,
  DROP COLUMN IF EXISTS group_name;

-- 先删旧签名再建：参数集变化，避免与带默认值的旧函数二义
DROP FUNCTION IF EXISTS upsert_user_activity(text, text, text, text, text, integer, integer, timestamptz, text, text);
CREATE OR REPLACE FUNCTION upsert_user_activity(
  p_chat_id text,
  p_od_id text DEFAULT NULL,
  p_od_name text DEFAULT NULL,
  p_message_count integer DEFAULT 1,
  p_token_usage integer DEFAULT 0,
  p_active_at timestamptz DEFAULT now(),
  p_bot_user_id text DEFAULT NULL,
  p_im_bot_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_date date := (p_active_at AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  INSERT INTO user_activity (
    chat_id, activity_date, od_id, od_name, message_count, token_usage, bot_user_id, im_bot_id, updated_at
  )
  VALUES (
    p_chat_id, v_date, p_od_id, p_od_name, p_message_count, p_token_usage, p_bot_user_id, p_im_bot_id, now()
  )
  ON CONFLICT (chat_id, activity_date) DO UPDATE SET
    od_id         = COALESCE(EXCLUDED.od_id, user_activity.od_id),
    od_name       = COALESCE(EXCLUDED.od_name, user_activity.od_name),
    message_count = user_activity.message_count + EXCLUDED.message_count,
    token_usage   = user_activity.token_usage + EXCLUDED.token_usage,
    bot_user_id   = COALESCE(EXCLUDED.bot_user_id, user_activity.bot_user_id),
    im_bot_id     = COALESCE(EXCLUDED.im_bot_id, user_activity.im_bot_id),
    updated_at    = now();
END;
$$;

-- get_active_users_from_user_activity 返回集含 group_id/group_name，随列删除重建
DROP FUNCTION IF EXISTS get_active_users_from_user_activity(timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION get_active_users_from_user_activity(
  p_start_date timestamptz,
  p_end_date   timestamptz
)
RETURNS TABLE(
  chat_id         text,
  od_id           text,
  od_name         text,
  bot_user_id     text,
  im_bot_id       text,
  message_count   bigint,
  token_usage     bigint,
  first_active_at timestamptz,
  last_active_at  timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ua.chat_id,
    MAX(ua.od_id)       AS od_id,
    MAX(ua.od_name)     AS od_name,
    MAX(ua.bot_user_id) AS bot_user_id,
    MAX(ua.im_bot_id)   AS im_bot_id,
    SUM(ua.message_count)::bigint AS message_count,
    SUM(ua.token_usage)::bigint   AS token_usage,
    MIN(ua.created_at)  AS first_active_at,
    MAX(ua.updated_at)  AS last_active_at
  FROM user_activity ua
  WHERE ua.activity_date >= (p_start_date AT TIME ZONE 'Asia/Shanghai')::date
    AND ua.activity_date <= (p_end_date   AT TIME ZONE 'Asia/Shanghai')::date
  GROUP BY ua.chat_id;
$$;

-- ============================================================
-- E4. 无用 / 冗余索引（静态分析：无谓词引用，或为更长复合索引的前缀）
-- ============================================================
DROP INDEX IF EXISTS idx_ops_events_corp_date_bot;              -- 3.5 MB，无任何谓词按此组合查 ops_events
DROP INDEX IF EXISTS idx_agent_long_term_memories_updated_at;   -- 1.6 MB，除建索引外零引用
DROP INDEX IF EXISTS idx_agent_long_term_memories_user;         -- (corp_id,user_id) 是 relation_unique 前缀
DROP INDEX IF EXISTS idx_message_batch_id;                      -- partial 条件 batch_id IS NOT NULL 覆盖 99.9%，等于全量
DROP INDEX IF EXISTS idx_reengagement_touch_session;            -- 是 (session_id,scenario_code,updated_at) 前缀
DROP INDEX IF EXISTS idx_test_executions_batch_id;              -- 被 3 个 batch_id 前导复合索引覆盖
DROP INDEX IF EXISTS idx_monitoring_daily_stats_stat_date;      -- 与 stat_date_key(unique) 同列
DROP INDEX IF EXISTS idx_hourly_stats_hour;                     -- 与 hour_key(unique) 同列

-- ============================================================
-- E5. 约束
-- ============================================================
-- 两条 interview.passed 的 occurred_at 来自海绵侧脏时间戳（2023 / 2025），事件本身真实，不删；
-- NOT VALID 只拦截新写入，不校验存量。
ALTER TABLE ops_events
  DROP CONSTRAINT IF EXISTS ops_events_report_date_sane,
  ADD CONSTRAINT ops_events_report_date_sane
    CHECK (report_date >= DATE '2026-01-01' AND report_date <= CURRENT_DATE + 1) NOT VALID;

-- ============================================================
-- E1. handoff_events：离线分析底账修复
-- ============================================================
-- 缺失的结果 / 闭环列 + 会话内序号
ALTER TABLE handoff_events
  ADD COLUMN IF NOT EXISTS sequence_no  integer,      -- 同一 chat 内第几次转人工（1 起）
  ADD COLUMN IF NOT EXISTS outcome      text,         -- resumed / expired / manual_closed …；人工介入回填
  ADD COLUMN IF NOT EXISTS resolved_at  timestamptz;

COMMENT ON COLUMN handoff_events.sequence_no IS '同一 chat_id 内按 created_at 的序号，区分"反复转"与"新问题"';
COMMENT ON COLUMN handoff_events.outcome     IS '人工接手后的结果，由托管恢复 / 介入关闭事件回填；NULL = 尚未闭环';

-- 回填 246 条：ops_events(handoff.triggered) 里带 source_table / backfill 标记的历史行
INSERT INTO handoff_events (
  corp_id, chat_id, user_id, reason_code, reason, action_advice, stage,
  bot_im_id, work_order_id, job_id, missing_job_info, idempotency_key, created_at
)
SELECT
  oe.corp_id,
  oe.chat_id,
  oe.user_id,
  COALESCE(oe.payload->>'reason_code', 'other'),
  oe.payload->>'reason',
  oe.payload->>'action_advice',
  oe.payload->>'stage',
  oe.bot_im_id,
  NULLIF(oe.payload->>'work_order_id', '')::bigint,
  NULLIF(oe.payload->>'job_id', '')::bigint,
  -- 列是 jsonb（应用侧直接落 JSON 数组），原样搬运，不转 text[]
  CASE WHEN jsonb_typeof(oe.payload->'missing_job_info') = 'array'
       THEN oe.payload->'missing_job_info'
       ELSE NULL END,
  oe.idempotency_key,
  oe.occurred_at
FROM ops_events oe
WHERE oe.event_name = 'handoff.triggered'
  AND oe.chat_id IS NOT NULL
ON CONFLICT (corp_id, idempotency_key) DO NOTHING;

-- 存量序号回填（按 chat_id, created_at）
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at, id) AS rn
  FROM handoff_events
)
UPDATE handoff_events h
SET sequence_no = ranked.rn
FROM ranked
WHERE h.id = ranked.id AND h.sequence_no IS NULL;

-- 写入侧序号：由 RPC 在插入时计算，避免应用层竞态
CREATE OR REPLACE FUNCTION next_handoff_sequence_no(p_corp_id text, p_chat_id text)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(MAX(sequence_no), 0) + 1
  FROM handoff_events
  WHERE corp_id = p_corp_id AND chat_id = p_chat_id;
$$;

-- ============================================================
-- B. 后台「全部」档：消息趋势换源到永久业务表
-- ============================================================
-- 消息数 = 候选人消息 + AI 回复（逻辑消息，不再计投递分段）；会话数 = 当日有业务事件的去重会话。
-- 两者都来自永久表，不受 chat_messages 保留期影响；起点由调用方给（安全起点 2026-06-01）。
CREATE OR REPLACE FUNCTION get_chat_business_daily_trend(
  p_start_date date,
  p_end_date   date
)
RETURNS TABLE(date date, message_count bigint, session_count bigint)
LANGUAGE sql
STABLE
AS $$
  WITH days AS (
    SELECT generate_series(p_start_date, p_end_date, interval '1 day')::date AS d
  ),
  msgs AS (
    SELECT report_date AS d,
           SUM(candidate_message_count + agent_reply_count)::bigint AS message_count
    FROM daily_ops_report
    WHERE report_date BETWEEN p_start_date AND p_end_date
    GROUP BY report_date
  ),
  sessions AS (
    SELECT report_date AS d, COUNT(DISTINCT chat_id)::bigint AS session_count
    FROM ops_events
    WHERE report_date BETWEEN p_start_date AND p_end_date
      AND chat_id IS NOT NULL
    GROUP BY report_date
  )
  SELECT days.d AS date,
         COALESCE(msgs.message_count, 0)     AS message_count,
         COALESCE(sessions.session_count, 0) AS session_count
  FROM days
  LEFT JOIN msgs     ON msgs.d = days.d
  LEFT JOIN sessions ON sessions.d = days.d
  ORDER BY days.d;
$$;

-- 各业务表的数据覆盖起点（「全部」档的真实起点，不伪装完整）
CREATE OR REPLACE FUNCTION get_business_data_floor()
RETURNS TABLE(ops_events_from date, daily_ops_report_from date, user_activity_from date)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (SELECT MIN(report_date)   FROM ops_events       WHERE report_date >= DATE '2026-01-01'),
    (SELECT MIN(report_date)   FROM daily_ops_report WHERE report_date >= DATE '2026-01-01'),
    (SELECT MIN(activity_date) FROM user_activity);
$$;
