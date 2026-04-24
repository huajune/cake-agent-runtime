ALTER TABLE public.test_executions
  ADD COLUMN IF NOT EXISTS reviewer_source character varying(50);

UPDATE public.test_executions
SET reviewer_source = CASE
  WHEN reviewed_by ILIKE '%codex%' THEN 'codex'
  WHEN reviewed_by ILIKE '%claude%' THEN 'claude'
  WHEN reviewed_by IS NOT NULL THEN 'manual'
  ELSE NULL
END
WHERE reviewer_source IS NULL;

ALTER TABLE public.test_executions
  DROP CONSTRAINT IF EXISTS test_executions_reviewer_source_check;

ALTER TABLE public.test_executions
  ADD CONSTRAINT test_executions_reviewer_source_check
  CHECK (
    reviewer_source IS NULL
    OR reviewer_source IN ('manual', 'codex', 'claude', 'system', 'api')
  );

COMMENT ON COLUMN public.test_executions.reviewer_source IS
  '评审来源：manual/codex/claude/system/api';

-- 通知 PostgREST 重载 schema 缓存，否则刚加的列/约束不会被 API 识别。
-- 与同批 20260423183000 / 20260423184000 / 20260423193000 的做法保持一致。
NOTIFY pgrst, 'reload schema';
