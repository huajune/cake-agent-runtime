-- 长期求职意向沉淀：agent_long_term_memories 新增 preference_facts 列。
--
-- 背景：settlement 此前只沉淀 interview_info 身份字段到 profile_facts；
-- preferences（意向城市/区域/品牌/岗位/班次/薪资等）整组只活在 Redis session
-- facts（TTL 2 天）里，候选人隔几天回来意向全部丢失、只剩摘要里的一句话叙述。
--
-- 结构：jsonb map，字段 → { value, confidence, source, evidence, updatedAt }
-- （与 profile_facts 同包裹结构）。覆盖语义为快照式整列覆盖（最新一段会话赢），
-- 不做数组累积——累积语义会让错值与错字变体永远清不掉。
ALTER TABLE agent_long_term_memories ADD COLUMN IF NOT EXISTS preference_facts jsonb;
