-- 为 agent_memories 表添加 profile_fields_meta 列
-- 用于记录每个 Profile 字段的来源、置信度和写入时间
-- source: 'booking' | 'extraction' | 'enrichment'
-- confidence: 'high' | 'medium'
-- writtenAt: ISO timestamp

ALTER TABLE agent_memories
  ADD COLUMN IF NOT EXISTS profile_fields_meta JSONB DEFAULT '{}';

COMMENT ON COLUMN agent_memories.profile_fields_meta IS
  'Per-field provenance metadata. Schema: { [field: string]: { source: string, confidence: string, writtenAt: string } }';
