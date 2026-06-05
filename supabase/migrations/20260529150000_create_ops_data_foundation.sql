-- ============================================================
-- 蛋糕运营数据体系 + 海绵工单集成 · 数据底座（P0-1）
--
-- 本迁移建立运营数据体系的全部持久化结构，是「写入侧」与
-- 「读取侧（conversion-analytics）」两条工作流的共享契约：
--
--   1. ops_events       事件底账（append-only，idempotency_key 去重）
--   2. daily_ops_report 每日每 bot 计数投影（从 ops_events 投影出来）
--   3. handoff_events    转人工触发分析底账
--   4. agent_long_term_memories.latest_booking   候选人最近预约工单指针
--   5. message_processing_records.is_synthetic    合成消息标记
--   6. RPC upsert_ops_event(...)                  写底账 + 投影日报（幂等）
--   7. RPC check_and_record_first_engaged(...)    原子破冰检测 + 写入
--
-- 关键约定：
--   - report_date 一律由 RPC 内部按 (occurred_at AT TIME ZONE 'Asia/Shanghai')::date
--     计算，调用方不传，避免 UTC 环境算错日期。
--   - 所有写入先 INSERT ops_events（ON CONFLICT DO NOTHING），仅当真正插入时
--     才投影 daily_ops_report +1，保证重复事件不会重复计数。
--   - daily_ops_report 全列皆可从 ops_events 重算，不存任何不可重建的状态。
-- ============================================================

-- ------------------------------------------------------------
-- 1. ops_events 事件底账表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_events (
  id bigserial PRIMARY KEY,
  corp_id text NOT NULL,               -- 多 corp 隔离
  event_name text NOT NULL,            -- 13 个事件名之一
  occurred_at timestamptz NOT NULL DEFAULT now(),  -- 事件实际发生时间
  report_date date NOT NULL,           -- 由 RPC 内部按 Asia/Shanghai 计算
  bot_im_id text,                      -- 归属 bot
  manager_name text,                   -- 冗余：bot 对应招聘经理
  group_name text,                     -- 冗余：bot 所属小组
  source_channel text,                 -- 候选人来源渠道（反范式冗余，便于按渠道切片）
  user_id text,                        -- 候选人 ID（cohort 漏斗 join 用）
  chat_id text,                        -- 会话 ID
  idempotency_key text NOT NULL,       -- 去重键
  payload jsonb,                       -- 事件元数据
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ops_events_idempotency_unique UNIQUE (corp_id, event_name, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ops_events_corp_date_bot
  ON ops_events (corp_id, report_date, bot_im_id);
CREATE INDEX IF NOT EXISTS idx_ops_events_corp_event_date
  ON ops_events (corp_id, event_name, report_date);
CREATE INDEX IF NOT EXISTS idx_ops_events_user_event
  ON ops_events (corp_id, user_id, event_name);
CREATE INDEX IF NOT EXISTS idx_ops_events_chat_event
  ON ops_events (corp_id, chat_id, event_name);
CREATE INDEX IF NOT EXISTS idx_ops_events_corp_channel
  ON ops_events (corp_id, source_channel, event_name);

ALTER TABLE ops_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on ops_events" ON ops_events;
CREATE POLICY "Service role full access on ops_events"
  ON ops_events
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 2. daily_ops_report 每日投影表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_ops_report (
  id bigserial PRIMARY KEY,
  corp_id text NOT NULL,                 -- 多 corp 隔离
  report_date date NOT NULL,
  bot_im_id text NOT NULL,
  manager_name text,
  group_name text,

  -- 12 个事件计数（period snapshot，当天事件数）
  friends_added_count        integer NOT NULL DEFAULT 0,  -- friend.added
  agent_opening_sent_count   integer NOT NULL DEFAULT 0,  -- agent.opening_sent
  break_ice_count            integer NOT NULL DEFAULT 0,  -- candidate.engaged（破冰数）
  candidate_message_count    integer NOT NULL DEFAULT 0,  -- candidate.message_received
  agent_reply_count          integer NOT NULL DEFAULT 0,  -- agent.replied
  job_recommend_count        integer NOT NULL DEFAULT 0,  -- job.recommended
  precheck_pass_count        integer NOT NULL DEFAULT 0,  -- precheck.passed
  booking_success_count      integer NOT NULL DEFAULT 0,  -- booking.succeeded
  booking_fail_count         integer NOT NULL DEFAULT 0,  -- booking.failed
  group_invite_count         integer NOT NULL DEFAULT 0,  -- group.invited
  handoff_count              integer NOT NULL DEFAULT 0,  -- handoff.triggered
  interview_pass_count       integer NOT NULL DEFAULT 0,  -- interview.passed

  -- booking 事件的衍生明细
  candidate_summary text,                -- 每人一行：姓名 手机号
  booking_brands text[],                 -- 报名品牌列表（去重）

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT daily_ops_report_unique UNIQUE (corp_id, report_date, bot_im_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_ops_report_corp_date
  ON daily_ops_report (corp_id, report_date);
CREATE INDEX IF NOT EXISTS idx_daily_ops_report_corp_group
  ON daily_ops_report (corp_id, group_name);

CREATE OR REPLACE FUNCTION update_daily_ops_report_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_daily_ops_report_updated_at ON daily_ops_report;
CREATE TRIGGER trigger_daily_ops_report_updated_at
  BEFORE UPDATE ON daily_ops_report
  FOR EACH ROW
  EXECUTE FUNCTION update_daily_ops_report_updated_at();

ALTER TABLE daily_ops_report ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on daily_ops_report" ON daily_ops_report;
CREATE POLICY "Service role full access on daily_ops_report"
  ON daily_ops_report
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 3. handoff_events 转人工触发分析底账
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS handoff_events (
  id bigserial PRIMARY KEY,
  chat_id text NOT NULL,
  corp_id text NOT NULL,
  user_id text,                        -- 候选人维度复盘
  reason_code text NOT NULL,           -- 原因代码（text 不设约束，可扩展）
  reason text,                         -- Agent 给的原话
  action_advice text,                  -- Agent 给的建议动作
  stage text,                          -- 触发时会话阶段（程序性阶段）
  bot_im_id text,                      -- 关联到 group
  work_order_id bigint,                -- modify_appointment 等场景关联工单
  idempotency_key text NOT NULL,       -- 去重
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT handoff_events_idempotency_unique UNIQUE (corp_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_handoff_events_corp_created
  ON handoff_events (corp_id, created_at);
CREATE INDEX IF NOT EXISTS idx_handoff_events_corp_reason
  ON handoff_events (corp_id, reason_code);
CREATE INDEX IF NOT EXISTS idx_handoff_events_corp_stage
  ON handoff_events (corp_id, stage);
CREATE INDEX IF NOT EXISTS idx_handoff_events_user_id
  ON handoff_events (user_id);

ALTER TABLE handoff_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on handoff_events" ON handoff_events;
CREATE POLICY "Service role full access on handoff_events"
  ON handoff_events
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 4. agent_long_term_memories.latest_booking 列
--    { latest_work_order_id, linked_at } —— 极简指针，永不清空
-- ------------------------------------------------------------
ALTER TABLE agent_long_term_memories
  ADD COLUMN IF NOT EXISTS latest_booking jsonb;

-- ------------------------------------------------------------
-- 5. message_processing_records.is_synthetic 列 + 部分索引
-- ------------------------------------------------------------
ALTER TABLE message_processing_records
  ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_mpr_synthetic
  ON message_processing_records (chat_id, received_at)
  WHERE is_synthetic = false;

-- ------------------------------------------------------------
-- 6. RPC：事件名 → daily_ops_report 计数列 映射
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION ops_event_projection_column(p_event_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_event_name
    WHEN 'friend.added'               THEN 'friends_added_count'
    WHEN 'agent.opening_sent'         THEN 'agent_opening_sent_count'
    WHEN 'candidate.engaged'          THEN 'break_ice_count'
    WHEN 'candidate.message_received' THEN 'candidate_message_count'
    WHEN 'agent.replied'              THEN 'agent_reply_count'
    WHEN 'job.recommended'            THEN 'job_recommend_count'
    WHEN 'precheck.passed'            THEN 'precheck_pass_count'
    WHEN 'booking.succeeded'          THEN 'booking_success_count'
    WHEN 'booking.failed'             THEN 'booking_fail_count'
    WHEN 'group.invited'              THEN 'group_invite_count'
    WHEN 'handoff.triggered'          THEN 'handoff_count'
    WHEN 'interview.passed'           THEN 'interview_pass_count'
    -- candidate.hired 不投影 daily_ops_report（仅 Web cohort/KPI 读 ops_events）
    ELSE NULL
  END
$$;

-- ------------------------------------------------------------
-- 6b. RPC：upsert_ops_event
--     写 ops_events 底账（幂等），仅当真正插入时投影 daily_ops_report。
--     report_date 内部按 Asia/Shanghai 计算，调用方不传。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_ops_event(
  p_corp_id text,
  p_event_name text,
  p_idempotency_key text,
  p_occurred_at timestamptz DEFAULT now(),
  p_bot_im_id text DEFAULT NULL,
  p_manager_name text DEFAULT NULL,
  p_group_name text DEFAULT NULL,
  p_source_channel text DEFAULT NULL,
  p_user_id text DEFAULT NULL,
  p_chat_id text DEFAULT NULL,
  p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_report_date date;
  v_inserted_count int := 0;
  v_column text;
  v_summary_line text;
  v_brand text;
BEGIN
  -- report_date 由 RPC 内部按上海时区计算
  v_report_date := (p_occurred_at AT TIME ZONE 'Asia/Shanghai')::date;

  -- 写底账（幂等：重复 idempotency_key 被 UNIQUE 拒绝）
  INSERT INTO ops_events (
    corp_id, event_name, occurred_at, report_date,
    bot_im_id, manager_name, group_name, source_channel,
    user_id, chat_id, idempotency_key, payload
  )
  VALUES (
    p_corp_id, p_event_name, p_occurred_at, v_report_date,
    p_bot_im_id, p_manager_name, p_group_name, p_source_channel,
    p_user_id, p_chat_id, p_idempotency_key, p_payload
  )
  ON CONFLICT (corp_id, event_name, idempotency_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  -- 仅当真正插入（非冲突跳过）且事件可投影且有 bot 归属时，才投影日报
  v_column := ops_event_projection_column(p_event_name);

  IF v_inserted_count > 0 AND v_column IS NOT NULL AND p_bot_im_id IS NOT NULL THEN
    -- 确保当天该 bot 的投影行存在
    INSERT INTO daily_ops_report (corp_id, report_date, bot_im_id, manager_name, group_name)
    VALUES (p_corp_id, v_report_date, p_bot_im_id, p_manager_name, p_group_name)
    ON CONFLICT (corp_id, report_date, bot_im_id) DO UPDATE
      SET manager_name = COALESCE(daily_ops_report.manager_name, EXCLUDED.manager_name),
          group_name   = COALESCE(daily_ops_report.group_name, EXCLUDED.group_name);

    -- 动态 +1 对应计数列
    EXECUTE format(
      'UPDATE daily_ops_report SET %I = %I + 1 '
      'WHERE corp_id = $1 AND report_date = $2 AND bot_im_id = $3',
      v_column, v_column
    ) USING p_corp_id, v_report_date, p_bot_im_id;

    -- booking.succeeded 衍生明细：candidate_summary（追加一行）+ booking_brands（去重追加）
    IF p_event_name = 'booking.succeeded' AND p_payload IS NOT NULL THEN
      v_summary_line := trim(
        COALESCE(p_payload->>'candidate_name', '') || ' ' || COALESCE(p_payload->>'phone', '')
      );
      IF v_summary_line <> '' THEN
        UPDATE daily_ops_report
        SET candidate_summary = CASE
              WHEN candidate_summary IS NULL OR candidate_summary = '' THEN v_summary_line
              ELSE candidate_summary || E'\n' || v_summary_line
            END
        WHERE corp_id = p_corp_id AND report_date = v_report_date AND bot_im_id = p_bot_im_id;
      END IF;

      v_brand := p_payload->>'brand_name';
      IF v_brand IS NOT NULL AND v_brand <> '' THEN
        UPDATE daily_ops_report
        SET booking_brands = (
          SELECT ARRAY(
            SELECT DISTINCT b
            FROM unnest(COALESCE(booking_brands, '{}'::text[]) || ARRAY[v_brand]) AS b
          )
        )
        WHERE corp_id = p_corp_id AND report_date = v_report_date AND bot_im_id = p_bot_im_id;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'inserted', v_inserted_count > 0,
    'report_date', v_report_date,
    'projected_column', v_column
  );
END;
$$;

-- ------------------------------------------------------------
-- 6c. RPC：check_and_record_first_engaged
--     原子完成「记录候选人消息 + 检测首条破冰」。
--     1) 先写 candidate.message_received（幂等键=企微 message_id）
--     2) 若此前该会话无更早的 candidate.message_received → 当前为破冰：
--        写 candidate.engaged（幂等键=chat_id+":engaged"，每会话仅一次）
--     用 occurred_at < T_now 严格小于，避免把当前消息误算进"之前"。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_and_record_first_engaged(
  p_corp_id text,
  p_chat_id text,
  p_message_id text,
  p_occurred_at timestamptz DEFAULT now(),
  p_bot_im_id text DEFAULT NULL,
  p_manager_name text DEFAULT NULL,
  p_group_name text DEFAULT NULL,
  p_source_channel text DEFAULT NULL,
  p_user_id text DEFAULT NULL,
  p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_prior_count int;
  v_engaged boolean := false;
  v_msg_result jsonb;
BEGIN
  -- 1) 记录候选人消息（幂等键=企微 message_id）
  v_msg_result := upsert_ops_event(
    p_corp_id          => p_corp_id,
    p_event_name       => 'candidate.message_received',
    p_idempotency_key  => p_message_id,
    p_occurred_at      => p_occurred_at,
    p_bot_im_id        => p_bot_im_id,
    p_manager_name     => p_manager_name,
    p_group_name       => p_group_name,
    p_source_channel   => p_source_channel,
    p_user_id          => p_user_id,
    p_chat_id          => p_chat_id,
    p_payload          => p_payload
  );

  -- 2) 该会话此前是否已有更早的候选人消息（严格小于当前 occurred_at）
  SELECT COUNT(*)
  INTO v_prior_count
  FROM ops_events
  WHERE corp_id = p_corp_id
    AND chat_id = p_chat_id
    AND event_name = 'candidate.message_received'
    AND occurred_at < p_occurred_at;

  IF v_prior_count = 0 THEN
    -- 首条破冰：写 candidate.engaged（幂等键保证每会话仅一次）
    PERFORM upsert_ops_event(
      p_corp_id          => p_corp_id,
      p_event_name       => 'candidate.engaged',
      p_idempotency_key  => p_chat_id || ':engaged',
      p_occurred_at      => p_occurred_at,
      p_bot_im_id        => p_bot_im_id,
      p_manager_name     => p_manager_name,
      p_group_name       => p_group_name,
      p_source_channel   => p_source_channel,
      p_user_id          => p_user_id,
      p_chat_id          => p_chat_id,
      p_payload          => p_payload
    );
    v_engaged := true;
  END IF;

  RETURN jsonb_build_object(
    'message_recorded', v_msg_result->'inserted',
    'engaged', v_engaged
  );
END;
$$;
