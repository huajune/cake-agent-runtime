-- 清洗成功且当前写入版本已支持四态后执行；与发布窗口同步，不能提前推到生产。
-- 所有检查在同一事务内，任一不满足则不安装约束。
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.agent_long_term_memories DROP CONSTRAINT IF EXISTS agent_long_term_memory_fact_integrity;
ALTER TABLE public.agent_long_term_memories ADD CONSTRAINT agent_long_term_memory_fact_integrity
  CHECK (public.memory_fact_columns_valid(semantic_profile, semantic_job_intent)) NOT VALID;
ALTER TABLE public.agent_long_term_memories VALIDATE CONSTRAINT agent_long_term_memory_fact_integrity;
COMMIT;
