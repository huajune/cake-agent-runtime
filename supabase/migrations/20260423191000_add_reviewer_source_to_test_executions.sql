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
