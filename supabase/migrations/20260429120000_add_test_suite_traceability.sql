ALTER TABLE public.test_executions
  ADD COLUMN IF NOT EXISTS source_trace jsonb,
  ADD COLUMN IF NOT EXISTS execution_trace jsonb,
  ADD COLUMN IF NOT EXISTS memory_setup jsonb,
  ADD COLUMN IF NOT EXISTS memory_assertions jsonb,
  ADD COLUMN IF NOT EXISTS memory_trace jsonb;

COMMENT ON COLUMN public.test_executions.source_trace IS
  '测试资产来源排障链路：BadCase/chat/message/trace/execution 等来源 ID。';
COMMENT ON COLUMN public.test_executions.execution_trace IS
  '测试执行链路快照：测试 scope、synthetic messageId、Agent 入口记忆、工具摘要等。';
COMMENT ON COLUMN public.test_executions.memory_setup IS
  '本次测试执行前灌入的记忆 fixture。';
COMMENT ON COLUMN public.test_executions.memory_assertions IS
  '本次测试执行关联的记忆能力断言。';
COMMENT ON COLUMN public.test_executions.memory_trace IS
  '本次测试执行的记忆评测证据：入口 memorySnapshot、turn-end 状态、post-turn session/procedural state。';

CREATE INDEX IF NOT EXISTS idx_test_executions_source_trace
  ON public.test_executions USING gin (source_trace);
CREATE INDEX IF NOT EXISTS idx_test_executions_execution_trace
  ON public.test_executions USING gin (execution_trace);
CREATE INDEX IF NOT EXISTS idx_test_executions_memory_trace
  ON public.test_executions USING gin (memory_trace);

ALTER TABLE public.test_conversation_snapshots
  ADD COLUMN IF NOT EXISTS source_trace jsonb,
  ADD COLUMN IF NOT EXISTS memory_setup jsonb,
  ADD COLUMN IF NOT EXISTS memory_assertions jsonb;

COMMENT ON COLUMN public.test_conversation_snapshots.source_trace IS
  '验证集对话源的来源排障链路：BadCase/chat/message/trace/execution 等来源 ID。';
COMMENT ON COLUMN public.test_conversation_snapshots.memory_setup IS
  '执行该验证集对话前灌入的记忆 fixture。';
COMMENT ON COLUMN public.test_conversation_snapshots.memory_assertions IS
  '该验证集对话关联的记忆能力断言。';

CREATE INDEX IF NOT EXISTS idx_conversation_snapshots_source_trace
  ON public.test_conversation_snapshots USING gin (source_trace);
