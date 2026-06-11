-- 给 timeout 兜底标记补「阶段归因」。
--
-- 背景：卡在 processing 的记录,所有 agent/timing 字段都只在终态写入,因此为 NULL,
-- 无法从行本身判断死在哪一阶段。但 message_id 形态是一个零成本的持久化信号：
--   - `batch_*` 行：已通过聚合/worker 进入处理 → 死在 Agent 执行或投递阶段
--   - 裸 message_id 行：源消息行只在聚合触发时被删除,仍存活说明聚合从未触发
--     → 死在入站/队列/锁阶段（debounce 未触发,高峰期静默丢消息的主嫌疑）
-- 据此把统一的「处理超时」拆成两类,让运营/排障一眼看出丢失发生在前段还是后段。
--
-- 同时分批化（与 null_agent_invocation / interrupt_stale_post_processing 一致）,
-- 避免一次 UPDATE 命中过多行触发 PostgREST 8s statement_timeout。

CREATE OR REPLACE FUNCTION timeout_stuck_records(
  p_stuck_minutes integer DEFAULT 30,
  p_limit integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE message_processing_records m
  SET
    status = 'timeout',
    error = CASE
      WHEN m.message_id LIKE 'batch\_%' THEN
        '处理超时（超过 ' || p_stuck_minutes || ' 分钟）- 已进入处理,Agent 执行或投递阶段中断'
      ELSE
        '处理超时（超过 ' || p_stuck_minutes || ' 分钟）- 未进入处理,入站/队列/锁阶段丢失（疑似聚合未触发）'
    END
  WHERE m.id IN (
    SELECT id FROM message_processing_records
    WHERE status = 'processing'
      AND received_at < NOW() - (p_stuck_minutes || ' minutes')::interval
    ORDER BY received_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;
