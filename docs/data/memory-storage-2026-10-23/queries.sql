-- 2026-10-23 18:39:20 +08:00 聚合快照查询口径。只读；不是迁移脚本。
-- 执行前确认目标环境。超过 50,000 行即拒绝，不降级为无界导出。
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
DO $$ BEGIN
 IF (SELECT count(*) FROM (SELECT 1 FROM public.agent_long_term_memories LIMIT 50001) bounded) > 50000 THEN
  RAISE EXCEPTION 'row budget exceeded';
 END IF;
END $$;
SELECT count(*) AS row_count FROM public.agent_long_term_memories;

select now() as at, pg_total_relation_size('public.agent_long_term_memories') as bytes, (select convalidated from pg_constraint where conname='agent_long_term_memory_fact_integrity') as integrity_validated;

select column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and table_name='agent_long_term_memories' order by ordinal_position;

select (bot_user_id is not null) as bot_scoped,count(*)::int as rows,
count(*) filter(where message_metadata is null or message_metadata='{}'::jsonb)::int metadata_empty,
count(*) filter(where exists(select 1 from jsonb_each(coalesce(semantic_profile,'{}')) f where f.value->'value' is not null and f.value->'value'<>'null'::jsonb))::int profile_rows,
count(*) filter(where exists(select 1 from jsonb_each(coalesce(semantic_job_intent,'{}')) f where f.value->'value' is not null and f.value->'value'<>'null'::jsonb))::int intent_rows,
count(*) filter(where jsonb_array_length(coalesce(episodic_session_summaries,'[]'))>0)::int summary_rows,
sum(jsonb_array_length(coalesce(episodic_session_summaries,'[]')))::int summaries,
count(*) filter(where active_booking is not null and active_booking<>'{}'::jsonb)::int booking_rows,
count(*) filter(where not public.memory_fact_columns_valid(semantic_profile,semantic_job_intent))::int invalid_rows
from public.agent_long_term_memories group by 1;

select semantic_profile->'has_health_certificate'->>'value' as state,count(*)::int rows from public.agent_long_term_memories where bot_user_id is not null group by 1 order by 2 desc;
COMMIT;
