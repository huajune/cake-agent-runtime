-- 图片信息结构化专项（docs/product/visual-fact-structuring-plan-2026-08-05.md §3.3）
-- 可空 jsonb 列：仅图片/表情消息行非空，与 content 的文本描述同源同时机写入。
-- PG 加可空列为元数据级 DDL，不重写表；不回填历史（NULL = 消费端视同 kind=other）。
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS visual_facts jsonb;
COMMENT ON COLUMN chat_messages.visual_facts IS
  'VisualFactSheet：图片/表情消息的结构化事实（kind/fields/rawDescription），与 content 文本描述同源写入。NULL=旧数据或非视觉消息，消费端视同 kind=other。';
