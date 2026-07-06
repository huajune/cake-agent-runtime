-- 修复触达状态机：duplicate（撞重跳过）不得覆盖真实投递结果态。
--
-- 现状：rank 只分 pending(1)/result(2) 两档，record_reengagement_touch 的 upsert 用
-- >= 判定，同 rank 后写覆盖先写。投递失败路径下这会洗掉最需人工核实的状态：
--   deliver 抛错 → trackDeliveryUnknown 落 unknown → rethrow → Bull(attempts:2) 30s 重试
--   → reserve 撞 Redis 槽位（非 sent）返回 duplicate_inflight → trackDuplicate 落 duplicate
--   → rank 2 >= 2，unknown 被覆盖为 duplicate，看板"状态不明" KPI 漏账（2026-07-06 review）。
--
-- 新口径三档：pending(1) < duplicate(2) < 其余结果态(3)。
-- - duplicate 仍可覆盖 pending（撞重比"还没到点"信息量大）；
-- - duplicate 不再覆盖 unknown/sent/failed 等真实投递结果；
-- - 结果态之间维持后写覆盖（>= 语义不变），events 轨迹照常追加不受影响。
CREATE OR REPLACE FUNCTION reengagement_touch_status_rank(p_status TEXT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_status IN ('scheduled', 'rescheduled') THEN 1
    WHEN p_status = 'duplicate' THEN 2
    ELSE 3
  END;
$$;
