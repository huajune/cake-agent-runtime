-- 修正看板总览的失败口径：processing（在途）不再被算作失败
--
-- 原实现 failure_count = COUNT(*) FILTER (WHERE status != 'success')，把三种非成功态
-- 一视同仁：failure（真失败）、timeout（消息被静默丢弃，确实是失败）、processing
-- （本轮还在跑，终态未知）。后者被计入失败纯属口径错误——查询瞬间在途的记录越多，
-- 看板成功率被压得越低，而且高峰期在途量最大，正好在最需要看数的时候最不准。
--
-- 同理 success_rate 的分母也应只含终态记录：在途记录既不该算成功也不该算失败，
-- 留在分母里等价于"默认判失败"。
--
-- total_messages 保持 COUNT(*)（= 该时间窗收到的全部记录，含在途），语义是"总消息数"，
-- 与失败率无关，不改动；需要在途量时从消息处理页按 status=processing 过滤即可。
--
-- 函数签名（返回列集）不变，故用 CREATE OR REPLACE 原地替换，无需 DROP、不留调用空窗。

CREATE OR REPLACE FUNCTION public.get_dashboard_overview_stats(
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
  total_token_usage bigint,
  avg_ttft numeric
)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::bigint AS total_messages,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint AS success_count,
    -- 只计真正的失败终态；processing 在途不计入
    COUNT(*) FILTER (WHERE m.status IN ('failure', 'timeout'))::bigint AS failure_count,
    ROUND(
      CASE
        -- 分母为终态记录数（success + failure + timeout），排除在途
        WHEN COUNT(*) FILTER (WHERE m.status IN ('success', 'failure', 'timeout')) > 0
        THEN (
          COUNT(*) FILTER (WHERE m.status = 'success')::numeric
          / COUNT(*) FILTER (WHERE m.status IN ('success', 'failure', 'timeout'))::numeric
        ) * 100
        ELSE 0
      END,
      2
    ) AS success_rate,
    ROUND(
      COALESCE(
        AVG(m.total_duration) FILTER (
          WHERE m.total_duration IS NOT NULL
            AND m.total_duration > 0
        ),
        0
      ),
      0
    ) AS avg_duration,
    COUNT(DISTINCT m.user_id)::bigint AS active_users,
    COUNT(DISTINCT m.chat_id)::bigint AS active_chats,
    COALESCE(
      SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL),
      0
    )::bigint AS total_token_usage,
    ROUND(
      COALESCE(
        AVG(m.ttft_ms) FILTER (WHERE m.ttft_ms IS NOT NULL AND m.ttft_ms > 0),
        0
      ),
      0
    ) AS avg_ttft
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date;
END;
$function$;
