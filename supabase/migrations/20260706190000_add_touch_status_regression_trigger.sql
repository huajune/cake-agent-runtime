-- 触达状态机回归防护下沉到表级（2026-07-06 发版 review）。
--
-- 现状：防回退口径只写在 record_reengagement_touch() 的 ON CONFLICT DO UPDATE 里，
-- 任何绕开该 RPC 的直接 UPDATE（人工修复脚本、未来新服务方法、Dashboard 直连）都不受约束，
-- 仍可把已完成触达（sent/unknown 等结果态）改回 scheduled 这类待定态。
--
-- 方案：BEFORE UPDATE 触发器复用 reengagement_touch_status_rank() 的三档口径
-- （pending 1 < duplicate 2 < 其余结果态 3），低 rank 覆盖高 rank 时静默保留原值——
-- 与 RPC 内 CASE 分支同语义，RPC 路径经过触发器时天然 no-op，不改变现有行为。
-- 需要人工强改状态时，先 ALTER TABLE ... DISABLE TRIGGER trg_touch_status_no_regression。
CREATE OR REPLACE FUNCTION reengagement_touch_block_status_regression()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND reengagement_touch_status_rank(NEW.status) < reengagement_touch_status_rank(OLD.status)
  THEN
    NEW.status := OLD.status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_status_no_regression ON reengagement_touch_records;
CREATE TRIGGER trg_touch_status_no_regression
  BEFORE UPDATE OF status ON reengagement_touch_records
  FOR EACH ROW
  EXECUTE FUNCTION reengagement_touch_block_status_regression();
