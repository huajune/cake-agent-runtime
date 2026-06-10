-- 观测数据卫生两件套：
--
-- 1. null_agent_invocation 改为分批执行
--    背景：PostgREST 连接角色 authenticator 配置了 statement_timeout=8s（lock_timeout=8s），
--    应用经 REST 调用的所有 RPC 均受此限制。夜间 03:00 cron 一次性 UPDATE 数千行
--    TOAST 大字段（agent_invocation 均值 ~40KB/行）必然超时，且失败后积压逐日增大、
--    形成"越积越超时"死循环——生产已观测到 >8 天记录全量未清、表膨胀至 689MB。
--    改为带 p_limit 的分批版本，由应用循环调用直到清完，单批稳定在 8s 内。
--
-- 2. interrupt_stale_post_processing 新增
--    背景：turn-end 记忆收尾先写 post_processing_status='running'，进程在收尾中途被杀
--    （发版 SIGTERM/崩溃）时终态永远不会落库，生产已积累 120+ 条永久 running 记录，
--    排障时无法区分"收尾进行中"与"收尾已丢失"。由小时级 cron 兜底标记为 interrupted。

-- 旧签名只有 (integer)，直接 CREATE 新签名会形成重载，
-- PostgREST 单参调用时产生歧义，必须先 DROP。
DROP FUNCTION IF EXISTS null_agent_invocation(integer);

CREATE OR REPLACE FUNCTION null_agent_invocation(
  p_days_old integer DEFAULT 7,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE message_processing_records m
  SET agent_invocation = NULL
  WHERE m.id IN (
    SELECT id FROM message_processing_records
    WHERE received_at < NOW() - (p_days_old || ' days')::interval
      AND agent_invocation IS NOT NULL
    ORDER BY received_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

CREATE OR REPLACE FUNCTION interrupt_stale_post_processing(
  p_stale_minutes integer DEFAULT 30,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE message_processing_records m
  SET post_processing_status = jsonb_set(
    m.post_processing_status,
    '{status}',
    '"interrupted"'
  ) || jsonb_build_object('interruptedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  WHERE m.id IN (
    SELECT id FROM message_processing_records
    WHERE post_processing_status->>'status' = 'running'
      -- 以收尾自身的 startedAt 判过期（updated_at 会被无关写入/触发器刷新，不可靠）
      AND COALESCE(
            (post_processing_status->>'startedAt')::timestamptz,
            updated_at
          ) < NOW() - (p_stale_minutes || ' minutes')::interval
    LIMIT p_limit
  );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;
