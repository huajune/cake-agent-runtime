-- Dashboard 查询性能：把三处「拉全量行到 Node 再聚合」的慢查询下沉到 DB 侧聚合。
--
-- 背景：以下三个接口原先都靠 PostgREST 分页把明细行全量拉到应用层再用 JS 归并，
-- 行数随留存增长线性放大，且 message_processing_records 的 jsonb 列会触发 TOAST detoast：
--   1. /analytics/user-trend        近 90 天需 18 次 1000 行往返 → 实测 11s
--   2. /analytics/dashboard/system  拉 24h 内 2000 行宽列，只为算一个 AVG(queue_duration) → 实测 6.5s
--   3. /analytics/chat-sessions*    get_chat_session_list 对 chat_messages 扫三遍再 JOIN → 实测 3.5s
--
-- 本迁移新增两个聚合函数，并把 get_chat_session_list 从「三次扫描 + 两次 LEFT JOIN」
-- 改写为「单次扫描 + 窗口函数」。函数签名与返回列保持不变，调用方无需改协议。

-- ============================================================
-- 1. 每日托管活跃聚合（替代 user_activity 全量分页拉取）
-- ============================================================
CREATE OR REPLACE FUNCTION get_user_activity_daily_stats(
  p_start_date date,
  p_end_date date
)
RETURNS TABLE(
  activity_date date,
  user_count bigint,
  message_count bigint,
  token_usage bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ua.activity_date,
    COUNT(*)::bigint AS user_count,
    COALESCE(SUM(ua.message_count), 0)::bigint AS message_count,
    COALESCE(SUM(ua.token_usage), 0)::bigint AS token_usage
  FROM user_activity ua
  WHERE ua.activity_date >= p_start_date
    AND ua.activity_date <= p_end_date
  GROUP BY ua.activity_date
  ORDER BY ua.activity_date ASC;
$$;

-- ============================================================
-- 2. 队列耗时聚合（替代为算一个均值而拉 2000 行宽列）
-- ============================================================
CREATE OR REPLACE FUNCTION get_queue_duration_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  sample_count bigint,
  avg_queue_duration double precision
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(mpr.queue_duration)::bigint AS sample_count,
    COALESCE(AVG(mpr.queue_duration), 0)::double precision AS avg_queue_duration
  FROM message_processing_records mpr
  WHERE mpr.received_at >= p_start_date
    AND mpr.received_at < p_end_date
    AND mpr.queue_duration IS NOT NULL;
$$;

-- ============================================================
-- 3. 会话列表：三次扫描 → 单次扫描 + 窗口函数，并支持游标分页 / 服务端搜索
-- ============================================================
-- 旧签名（仅 p_start_date/p_end_date）必须先 DROP：新函数的分页参数带默认值，
-- 两者共存会让「只传两个参数」的调用命中 function is not unique。
DROP FUNCTION IF EXISTS get_chat_session_list(
  timestamp with time zone,
  timestamp with time zone
);

-- 分页用游标（keyset）而非 offset：会话按最后消息时间倒序，新消息会把会话顶到列表头，
-- offset 分页会因此整体漂移、翻页出现重复/漏项；游标锚在 (last_timestamp, chat_id) 上不受影响。
-- total_count 在游标裁剪前用窗口函数算出，让 UI 能显示真实总数而不是「已加载条数」。
CREATE OR REPLACE FUNCTION get_chat_session_list(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone,
  p_limit integer DEFAULT NULL,
  p_search text DEFAULT NULL,
  p_cursor_timestamp timestamp with time zone DEFAULT NULL,
  p_cursor_chat_id text DEFAULT NULL
)
RETURNS TABLE(
  chat_id text,
  candidate_name text,
  manager_name text,
  message_count bigint,
  last_message text,
  last_timestamp timestamp with time zone,
  avatar text,
  contact_type text,
  total_count bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT
      cm.chat_id,
      cm.content,
      cm.timestamp,
      cm.manager_name,
      cm.candidate_name,
      cm.avatar,
      cm.contact_type,
      cm.role,
      -- 全量消息里的最新一条（用于 last_message / last_timestamp）
      ROW_NUMBER() OVER (PARTITION BY cm.chat_id ORDER BY cm.timestamp DESC) AS rn_all,
      -- 仅 user 消息里的最新一条（用于候选人姓名/头像/联系人类型）
      ROW_NUMBER() OVER (
        PARTITION BY cm.chat_id, (cm.role = 'user') ORDER BY cm.timestamp DESC
      ) AS rn_by_role
    FROM chat_messages cm
    WHERE cm.timestamp >= p_start_date
      AND cm.timestamp <= p_end_date
  ),
  grouped AS (
    SELECT
      s.chat_id,
      COALESCE(MAX(CASE WHEN s.role = 'user' AND s.rn_by_role = 1 THEN s.candidate_name END), '')
        AS candidate_name,
      COALESCE(MAX(s.manager_name), '') AS manager_name,
      COUNT(*)::bigint AS message_count,
      COALESCE(
        MAX(CASE
              WHEN s.rn_all = 1 AND LENGTH(s.content) > 50
                THEN SUBSTRING(s.content FROM 1 FOR 50) || '...'
              WHEN s.rn_all = 1 THEN s.content
            END),
        ''
      ) AS last_message,
      MAX(CASE WHEN s.rn_all = 1 THEN s.timestamp END) AS last_timestamp,
      COALESCE(MAX(CASE WHEN s.role = 'user' AND s.rn_by_role = 1 THEN s.avatar END), '')
        AS avatar,
      COALESCE(MAX(CASE WHEN s.role = 'user' AND s.rn_by_role = 1 THEN s.contact_type END), '')
        AS contact_type
    FROM scoped s
    GROUP BY s.chat_id
  ),
  -- 搜索下推到 DB：命中范围是整个时间窗，而不是前端已加载的那几页
  searched AS (
    SELECT g.*
    FROM grouped g
    WHERE p_search IS NULL
       OR p_search = ''
       OR g.candidate_name ILIKE '%' || p_search || '%'
       OR g.manager_name ILIKE '%' || p_search || '%'
       OR g.last_message ILIKE '%' || p_search || '%'
  ),
  counted AS (
    SELECT s.*, COUNT(*) OVER ()::bigint AS total_count
    FROM searched s
  )
  SELECT
    c.chat_id,
    c.candidate_name,
    c.manager_name,
    c.message_count,
    c.last_message,
    c.last_timestamp,
    c.avatar,
    c.contact_type,
    c.total_count
  FROM counted c
  WHERE p_cursor_timestamp IS NULL
     OR (c.last_timestamp, c.chat_id) < (p_cursor_timestamp, COALESCE(p_cursor_chat_id, ''))
  ORDER BY c.last_timestamp DESC, c.chat_id DESC
  LIMIT p_limit;
$$;

-- ============================================================
-- 4. 每日消息统计：消除 COUNT(DISTINCT) 引发的落盘排序
-- ============================================================
-- 原实现 `COUNT(DISTINCT chat_id) GROUP BY DATE(timestamp)` 会强制按
-- (date, chat_id) 对全部命中行做排序；「近 3 月」27 万行超出 work_mem，
-- 实测 Sort Method: external merge Disk: 10480kB —— 排序落盘吃掉约 300ms。
--
-- 改成两级聚合：内层按 (date, chat_id) 去重（HashAggregate，不落盘），
-- 外层按 date 汇总。结果逐行等价，生产实测 589ms → 280ms。
CREATE OR REPLACE FUNCTION get_chat_daily_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(date date, message_count bigint, session_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    d.date,
    SUM(d.cnt)::bigint AS message_count,
    COUNT(*)::bigint AS session_count
  FROM (
    SELECT
      DATE(cm.timestamp) AS date,
      cm.chat_id,
      COUNT(*) AS cnt
    FROM chat_messages cm
    WHERE cm.timestamp >= p_start_date
      AND cm.timestamp <= p_end_date
    GROUP BY DATE(cm.timestamp), cm.chat_id
  ) d
  GROUP BY d.date
  ORDER BY d.date ASC;
$$;
