-- 转化分析（/analytics/conversion/*）聚合下沉到数据库。
--
-- 此前 ConversionAnalyticsService 按 report_date + event_name 翻页拉全量 ops_events 明细
-- （PostgREST max_rows=1000，一页一次往返）再在 Node 去重/匹配：30 天窗口要跑 20～30 次
-- 串行往返，「全部」档近百次；且每个仪表盘打开都并发 5 个接口重复拉同一批明细。
-- 三个 STABLE 函数把去重计数与 cohort 匹配放进 SQL，一次往返返回按 总量/逐日/逐 bot
-- 聚合后的少量行；语义与原 Node 实现逐条对齐（见各函数注释），已用生产数据对账。
--
-- 依赖索引：idx_ops_events_corp_event_date (corp_id, event_name, report_date)。
-- 小组过滤：调用方把「所选小组」与「解析到这些小组的 bot 归一化 key」一起传入，
-- 事件自带 group_name 时按名字比，缺失/未分组时按 bot 归属比（与 BotGroupResolver 一致）。

-- 归一化 bot_im_id：剥掉测试库同步前缀 'prod-sync:' 并 trim（对齐 normalizeBotImId）。
CREATE OR REPLACE FUNCTION conversion_normalize_bot_im_id(p_bot_im_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN btrim(p_bot_im_id) LIKE 'prod-sync:%' THEN btrim(substr(btrim(p_bot_im_id), 11))
    ELSE btrim(p_bot_im_id)
  END;
$$;

-- 事件是否命中小组筛选（对齐 enrichOpsEvent + matchesGroupFilter）：
-- 未选小组 → 全部通过；事件 group_name 有效 → 按名字；空/未分组 → 按 bot 解析归属。
CREATE OR REPLACE FUNCTION conversion_event_matches_groups(
  p_group_name   text,
  p_bot_im_id    text,
  p_groups       text[],
  p_group_bot_ids text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_groups IS NULL OR cardinality(p_groups) = 0 THEN true
    WHEN nullif(p_group_name, '') IS NULL OR p_group_name = '未分组' THEN
      p_bot_im_id IS NOT NULL
      AND conversion_normalize_bot_im_id(p_bot_im_id) = ANY (coalesce(p_group_bot_ids, '{}'::text[]))
    ELSE p_group_name = ANY (p_groups)
  END;
$$;

-- 同一时段（period）口径：各阶段在窗口内独立去重。
-- 去重键（对齐 addPeriodEventToSets）：好友/破冰/加群 = user_id → chat_id → idempotency_key；
-- 报名/面试通过 = user_id → chat_id → payload 工单号 → idempotency_key 冒号前缀 → idempotency_key。
-- 返回三种粒度：scope='total'（窗口总量，跨 bot 按人去重）、'day'（bucket=report_date）、
-- 'bot'（bucket=bot_im_id，manager/group 取该 bot 最早一条事件的原始值，由调用方再做解析补全）。
CREATE OR REPLACE FUNCTION conversion_period_stats(
  p_start_date    date,
  p_end_date      date,
  p_corp_id       text   DEFAULT NULL,
  p_groups        text[] DEFAULT NULL,
  p_group_bot_ids text[] DEFAULT NULL
)
RETURNS TABLE(
  scope          text,
  bucket         text,
  bot_im_id      text,
  manager_name   text,
  group_name     text,
  friend_added   bigint,
  break_ice      bigint,
  booking        bigint,
  group_invite   bigint,
  interview_pass bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH src AS (
    SELECT e.id, e.event_name, e.report_date, e.occurred_at, e.bot_im_id, e.manager_name, e.group_name,
           nullif(btrim(e.user_id), '') AS user_id,
           nullif(btrim(e.chat_id), '') AS chat_id,
           nullif(btrim(e.idempotency_key), '') AS idempotency_key,
           coalesce(
             nullif(btrim(e.payload->>'work_order_id'), ''),
             nullif(btrim(e.payload->>'workOrderId'), ''),
             nullif(btrim(e.payload->>'latest_work_order_id'), ''),
             nullif(btrim(e.payload->>'latestWorkOrderId'), ''),
             nullif(split_part(btrim(e.idempotency_key), ':', 1), '')
           ) AS work_order_id
    FROM ops_events e
    WHERE e.report_date BETWEEN p_start_date AND p_end_date
      AND e.event_name IN ('friend.added', 'candidate.engaged', 'booking.succeeded', 'group.invited', 'interview.passed')
      AND (p_corp_id IS NULL OR e.corp_id = p_corp_id)
      AND conversion_event_matches_groups(e.group_name, e.bot_im_id, p_groups, p_group_bot_ids)
  ),
  ev AS (
    SELECT r.*,
           CASE WHEN r.event_name IN ('booking.succeeded', 'interview.passed')
                THEN coalesce(r.user_id, r.chat_id, r.work_order_id, r.idempotency_key)
                ELSE coalesce(r.user_id, r.chat_id, r.idempotency_key)
           END AS dedup_key
    FROM src r
  ),
  keyed AS (SELECT * FROM ev WHERE dedup_key IS NOT NULL)
  SELECT 'total'::text, NULL::text, NULL::text, NULL::text, NULL::text,
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'friend.added'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'candidate.engaged'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'booking.succeeded'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'group.invited'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'interview.passed')
  FROM keyed
  UNION ALL
  SELECT 'day', report_date::text, NULL, NULL, NULL,
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'friend.added'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'candidate.engaged'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'booking.succeeded'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'group.invited'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'interview.passed')
  FROM keyed
  GROUP BY report_date
  UNION ALL
  SELECT 'bot', coalesce(bot_im_id, 'unknown'), bot_im_id,
         (array_agg(manager_name ORDER BY occurred_at, id))[1],
         (array_agg(group_name ORDER BY occurred_at, id))[1],
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'friend.added'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'candidate.engaged'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'booking.succeeded'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'group.invited'),
         count(DISTINCT dedup_key) FILTER (WHERE event_name = 'interview.passed')
  FROM keyed
  GROUP BY coalesce(bot_im_id, 'unknown'), bot_im_id;
$$;

-- 同批追踪（cohort，新增好友批次）口径，对齐 computeCohortRawSets + constrainStageSets：
-- - 成员 = 入列窗口 [p_base_start, p_base_end] 内 friend.added，按 user_id→chat_id 身份去重，
--   取最早一条（occurred_at, id）作为入列时刻与归属 bot。
-- - 下游事件取 [p_base_start, p_observe_end]（含成熟观察期），先按 user_id 命中成员，
--   未命中再按 chat_id 回退，且事件时刻不早于入列时刻。
-- - 严格单调子集：破冰 ⊇ 报名 ⊇ 面试通过；加群 = 破冰 ∩ 加群（侧支）。
-- 每个成员只属于一个 (cohort_date, bot)，因此逐日/逐 bot/总量都可由本函数返回行直接求和。
-- cohort_date = 入列时刻的 Asia/Shanghai 日期（对齐 formatLocalDate）。
CREATE OR REPLACE FUNCTION conversion_cohort_stats(
  p_base_start    date,
  p_base_end      date,
  p_observe_end   date,
  p_corp_id       text   DEFAULT NULL,
  p_groups        text[] DEFAULT NULL,
  p_group_bot_ids text[] DEFAULT NULL
)
RETURNS TABLE(
  cohort_date       date,
  bot_im_id         text,
  manager_name      text,
  group_name        text,
  first_occurred_at timestamptz,
  friend_added      bigint,
  break_ice         bigint,
  booking           bigint,
  group_invite      bigint,
  interview_pass    bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH base AS (
    SELECT e.id, e.occurred_at, e.bot_im_id, e.manager_name, e.group_name,
           nullif(e.user_id, '') AS user_id,
           nullif(e.chat_id, '') AS chat_id,
           coalesce(nullif(e.user_id, ''), nullif(e.chat_id, '')) AS identity
    FROM ops_events e
    WHERE e.event_name = 'friend.added'
      AND e.report_date BETWEEN p_base_start AND p_base_end
      AND (p_corp_id IS NULL OR e.corp_id = p_corp_id)
      AND conversion_event_matches_groups(e.group_name, e.bot_im_id, p_groups, p_group_bot_ids)
  ),
  members AS (
    SELECT DISTINCT ON (identity)
           identity, id, occurred_at, user_id, chat_id, bot_im_id, manager_name, group_name
    FROM base
    WHERE identity IS NOT NULL
    ORDER BY identity, occurred_at, id
  ),
  down AS (
    SELECT e.event_name, e.occurred_at,
           nullif(e.user_id, '') AS user_id,
           nullif(e.chat_id, '') AS chat_id
    FROM ops_events e
    WHERE e.event_name IN ('candidate.engaged', 'booking.succeeded', 'interview.passed', 'group.invited')
      AND e.report_date BETWEEN p_base_start AND p_observe_end
      AND (p_corp_id IS NULL OR e.corp_id = p_corp_id)
      AND conversion_event_matches_groups(e.group_name, e.bot_im_id, p_groups, p_group_bot_ids)
  ),
  -- chat_id 回退索引：同一 chat_id 对应多个成员时取最晚入列者（对齐 Node 侧 Map 后写覆盖）。
  -- 预先去重成映射表走 hash join；逐行 LATERAL 在「全部」档（数万下游事件 × 数万成员）会超时。
  members_by_chat AS (
    SELECT DISTINCT ON (chat_id) chat_id, identity, occurred_at
    FROM members
    WHERE chat_id IS NOT NULL
    ORDER BY chat_id, occurred_at DESC, id DESC
  ),
  matched AS (
    SELECT d.event_name, d.occurred_at,
           coalesce(mu.identity, mc.identity)       AS identity,
           coalesce(mu.occurred_at, mc.occurred_at) AS member_at
    FROM down d
    LEFT JOIN members mu ON d.user_id IS NOT NULL AND mu.user_id = d.user_id
    LEFT JOIN members_by_chat mc
      ON mu.identity IS NULL AND d.chat_id IS NOT NULL AND mc.chat_id = d.chat_id
  ),
  flags AS (
    SELECT identity,
           bool_or(event_name = 'candidate.engaged') AS be,
           bool_or(event_name = 'booking.succeeded') AS bk,
           bool_or(event_name = 'interview.passed')  AS ip,
           bool_or(event_name = 'group.invited')     AS gi
    FROM matched
    WHERE identity IS NOT NULL AND occurred_at >= member_at
    GROUP BY identity
  )
  SELECT (m.occurred_at AT TIME ZONE 'Asia/Shanghai')::date,
         m.bot_im_id,
         (array_agg(m.manager_name ORDER BY m.occurred_at, m.id))[1],
         (array_agg(m.group_name   ORDER BY m.occurred_at, m.id))[1],
         min(m.occurred_at),
         count(*),
         count(*) FILTER (WHERE f.be),
         count(*) FILTER (WHERE f.be AND f.bk),
         count(*) FILTER (WHERE f.be AND f.gi),
         count(*) FILTER (WHERE f.be AND f.bk AND f.ip)
  FROM members m
  LEFT JOIN flags f USING (identity)
  GROUP BY 1, 2;
$$;

-- 转人工原因分布（对齐 getHandoff）：reason_code 取 payload.reason_code trim，空则 'other'。
CREATE OR REPLACE FUNCTION conversion_handoff_reasons(
  p_start_date    date,
  p_end_date      date,
  p_corp_id       text   DEFAULT NULL,
  p_groups        text[] DEFAULT NULL,
  p_group_bot_ids text[] DEFAULT NULL
)
RETURNS TABLE(reason_code text, event_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(nullif(btrim(e.payload->>'reason_code'), ''), 'other'),
         count(*)
  FROM ops_events e
  WHERE e.event_name = 'handoff.triggered'
    AND e.report_date BETWEEN p_start_date AND p_end_date
    AND (p_corp_id IS NULL OR e.corp_id = p_corp_id)
    AND conversion_event_matches_groups(e.group_name, e.bot_im_id, p_groups, p_group_bot_ids)
  GROUP BY 1
  ORDER BY 2 DESC;
$$;
