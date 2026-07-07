-- 二次触发（reengagement 复聊）触达追溯表
--
-- 背景：二次触发的排程/决策/投递此前只存在于 Redis（Bull job 7 天、触达槽 TTL 3 天）
-- 和日志里，事后无法回答"这个会话为什么没跟进 / 跟进发了什么 / 投递到底成没成功"。
-- 本表把一次触达的完整生命周期落库：锚点 → 排程 → 到点决策 → 生成 → 投递终态。
--
-- 设计：一行 = 一次触达（以 touch_key 幂等，等于 Bull jobId：sessionId:scenarioCode:anchorEventId），
-- 随生命周期推进原地更新；events 数组追加每次状态流转，详情页可还原全过程。
-- Redis 底账（频控/outbox 幂等）职责不变，本表纯观测，写入失败不阻塞主流程。

CREATE TABLE IF NOT EXISTS reengagement_touch_records (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 身份与关联
  touch_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT,
  corp_id TEXT,
  scenario_code TEXT NOT NULL,
  anchor_event_id TEXT,
  anchor_at TIMESTAMPTZ,
  job_id TEXT,

  -- 生命周期终态摘要（列表页一眼看结局）
  status TEXT NOT NULL,
  decision_reason TEXT,
  shadow BOOLEAN,

  -- 时间线
  fire_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  fired_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,

  -- 生成与投递
  outcome_kind TEXT,
  generated_text TEXT,
  reserve_result TEXT,
  error TEXT,

  -- 全轨迹：[{at, event, detail}]，每次状态流转追加一条
  events JSONB NOT NULL DEFAULT '[]'::jsonb
);

COMMENT ON TABLE reengagement_touch_records IS '二次触发（复聊）触达追溯：一行一次触达（touch_key 幂等），随生命周期原地更新，events 保留全轨迹。Redis 底账仍负责在线频控/幂等，本表纯观测';
COMMENT ON COLUMN reengagement_touch_records.touch_key IS '幂等键 = sessionId:scenarioCode:anchorEventId（等于排程时的 Bull jobId）';
COMMENT ON COLUMN reengagement_touch_records.status IS '生命周期状态：scheduled(已排程待到点) / skipped(排程前预检停止) / disabled(到点时总开关关闭丢弃) / stopped(到点停止条件命中) / frequency_blocked(频控丢弃) / rescheduled(窗口外改期) / duplicate(reserve 撞重跳过) / shadow(生成未投递) / sent(已投递) / failed(生成非reply或投递失败) / unknown(投递状态不明，需人工核对)';
COMMENT ON COLUMN reengagement_touch_records.decision_reason IS '决策原因：shouldStop 的 reason（terminal:booked / candidate_replied_after_anchor / scenario_no_longer_holds…）、频控、duplicate_sent/inflight 等';
COMMENT ON COLUMN reengagement_touch_records.shadow IS '是否 shadow 分支（生成了文案但不投递；含全局 shadow 配置与场景 rolloutEnabled=false）';
COMMENT ON COLUMN reengagement_touch_records.fire_at IS '计划触发时间（含 9-21 窗口对齐；rescheduled 时更新为新时间）';
COMMENT ON COLUMN reengagement_touch_records.outcome_kind IS '主动回合结果：reply / skipped / guardrail_blocked / handoff';
COMMENT ON COLUMN reengagement_touch_records.generated_text IS '生成的跟进文案（shadow 分支为"本应发"的文案）';
COMMENT ON COLUMN reengagement_touch_records.reserve_result IS 'Redis 触达槽占位结果：reserved / duplicate_sent / duplicate_inflight';
COMMENT ON COLUMN reengagement_touch_records.events IS '状态流转全轨迹：[{at: ISO时间, event: 事件名, detail?: 附加信息}]';

CREATE UNIQUE INDEX IF NOT EXISTS idx_reengagement_touch_key ON reengagement_touch_records (touch_key);
CREATE INDEX IF NOT EXISTS idx_reengagement_touch_created ON reengagement_touch_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reengagement_touch_session ON reengagement_touch_records (session_id);
CREATE INDEX IF NOT EXISTS idx_reengagement_touch_status ON reengagement_touch_records (status);
CREATE INDEX IF NOT EXISTS idx_reengagement_touch_scenario ON reengagement_touch_records (scenario_code);

-- 原子 upsert + 事件追加：scheduler 与 processor 并发写同一行时不丢事件。
-- 语义：非空参数覆盖对应列（status 也是"最后写入者胜"，调用方保证状态推进顺序），
-- p_event 追加到 events 数组，updated_at 总是刷新。
CREATE OR REPLACE FUNCTION record_reengagement_touch(
  p_touch_key TEXT,
  p_session_id TEXT DEFAULT NULL,
  p_user_id TEXT DEFAULT NULL,
  p_corp_id TEXT DEFAULT NULL,
  p_scenario_code TEXT DEFAULT NULL,
  p_anchor_event_id TEXT DEFAULT NULL,
  p_anchor_at TIMESTAMPTZ DEFAULT NULL,
  p_job_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_decision_reason TEXT DEFAULT NULL,
  p_shadow BOOLEAN DEFAULT NULL,
  p_fire_at TIMESTAMPTZ DEFAULT NULL,
  p_scheduled_at TIMESTAMPTZ DEFAULT NULL,
  p_fired_at TIMESTAMPTZ DEFAULT NULL,
  p_sent_at TIMESTAMPTZ DEFAULT NULL,
  p_outcome_kind TEXT DEFAULT NULL,
  p_generated_text TEXT DEFAULT NULL,
  p_reserve_result TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL,
  p_event JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO reengagement_touch_records (
    touch_key, session_id, user_id, corp_id, scenario_code,
    anchor_event_id, anchor_at, job_id,
    status, decision_reason, shadow,
    fire_at, scheduled_at, fired_at, sent_at,
    outcome_kind, generated_text, reserve_result, error, events
  ) VALUES (
    p_touch_key,
    COALESCE(p_session_id, ''),
    p_user_id,
    p_corp_id,
    COALESCE(p_scenario_code, ''),
    p_anchor_event_id,
    p_anchor_at,
    p_job_id,
    COALESCE(p_status, 'scheduled'),
    p_decision_reason,
    p_shadow,
    p_fire_at,
    p_scheduled_at,
    p_fired_at,
    p_sent_at,
    p_outcome_kind,
    p_generated_text,
    p_reserve_result,
    p_error,
    COALESCE(jsonb_build_array(p_event), '[]'::jsonb)
  )
  ON CONFLICT (touch_key) DO UPDATE SET
    session_id      = COALESCE(NULLIF(EXCLUDED.session_id, ''), reengagement_touch_records.session_id),
    user_id         = COALESCE(EXCLUDED.user_id, reengagement_touch_records.user_id),
    corp_id         = COALESCE(EXCLUDED.corp_id, reengagement_touch_records.corp_id),
    scenario_code   = COALESCE(NULLIF(EXCLUDED.scenario_code, ''), reengagement_touch_records.scenario_code),
    anchor_event_id = COALESCE(EXCLUDED.anchor_event_id, reengagement_touch_records.anchor_event_id),
    anchor_at       = COALESCE(EXCLUDED.anchor_at, reengagement_touch_records.anchor_at),
    job_id          = COALESCE(EXCLUDED.job_id, reengagement_touch_records.job_id),
    status          = COALESCE(p_status, reengagement_touch_records.status),
    decision_reason = COALESCE(p_decision_reason, reengagement_touch_records.decision_reason),
    shadow          = COALESCE(p_shadow, reengagement_touch_records.shadow),
    fire_at         = COALESCE(p_fire_at, reengagement_touch_records.fire_at),
    scheduled_at    = COALESCE(p_scheduled_at, reengagement_touch_records.scheduled_at),
    fired_at        = COALESCE(p_fired_at, reengagement_touch_records.fired_at),
    sent_at         = COALESCE(p_sent_at, reengagement_touch_records.sent_at),
    outcome_kind    = COALESCE(p_outcome_kind, reengagement_touch_records.outcome_kind),
    generated_text  = COALESCE(p_generated_text, reengagement_touch_records.generated_text),
    reserve_result  = COALESCE(p_reserve_result, reengagement_touch_records.reserve_result),
    error           = COALESCE(p_error, reengagement_touch_records.error),
    events          = CASE
                        WHEN p_event IS NULL THEN reengagement_touch_records.events
                        ELSE reengagement_touch_records.events || jsonb_build_array(p_event)
                      END,
    updated_at      = now();
END;
$$;

-- RLS：沿用观测表既有约定（public 读，service_role 写）
ALTER TABLE reengagement_touch_records ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'reengagement_touch_records' AND policyname = 'Allow public read'
  ) THEN
    CREATE POLICY "Allow public read" ON reengagement_touch_records AS PERMISSIVE FOR SELECT TO public USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'reengagement_touch_records' AND policyname = 'Service role insert'
  ) THEN
    CREATE POLICY "Service role insert" ON reengagement_touch_records AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'reengagement_touch_records' AND policyname = 'Service role update'
  ) THEN
    CREATE POLICY "Service role update" ON reengagement_touch_records AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'reengagement_touch_records' AND policyname = 'Service role delete'
  ) THEN
    CREATE POLICY "Service role delete" ON reengagement_touch_records AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
END $$;

-- 加入 realtime publication（页面实时刷新，与 message_processing_records 同机制）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'reengagement_touch_records'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reengagement_touch_records;
  END IF;
END $$;
