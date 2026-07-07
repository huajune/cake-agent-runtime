-- 修复 guardrail_review_records.trace_id 索引缺失 UNIQUE 约束
--
-- 背景：生产库先落了早期草稿版索引（普通 btree），20260703100000 的
-- CREATE UNIQUE INDEX IF NOT EXISTS 因同名索引已存在被跳过，索引保持非 unique。
-- 应用层 GuardrailReviewRepository.upsert(onConflict:'trace_id') 因此全部报
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification"，
-- 该表自 v5.31.0 上线起 0 行（fire-and-forget 只打 warn，无告警）。
--
-- 重建为 UNIQUE。先按 trace_id 去重（保留最新 id）保证幂等可重跑。
DELETE FROM guardrail_review_records a
  USING guardrail_review_records b
  WHERE a.trace_id = b.trace_id AND a.id < b.id;

DROP INDEX IF EXISTS idx_guardrail_review_trace;
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardrail_review_trace
  ON guardrail_review_records (trace_id);
