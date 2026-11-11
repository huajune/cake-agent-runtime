-- R8 / GP-01：保留品牌名消歧，招聘城市由本轮查岗确定。
DO $migration$
DECLARE
  -- 测试、生产及历史迁移中出现过的 R8 原文。按整条匹配以保留运营的其他编辑。
  old_rules constant text[] := ARRAY[
    '品牌开城限制 — 成都你六姐（六姐）目前仅在上海有在招岗位。候选人提到该品牌时无需追问城市，默认按上海查询；若候选人在其他城市，明确告知该品牌当前其他城市暂未开店。',
    '成都你六姐（六姐）仅上海在招——候选人提及该品牌时默认按上海查询，其他城市候选人直接告知"该品牌其他城市暂未开店"。',
    '“成都你六姐”是一个完整的品牌名，禁止再拆成城市，目前仅上海在招——候选人提及“成都你六姐”时默认按上海查询，其他城市候选人直接告知"该品牌其他城市暂未开店"。',
    '“成都你六姐”是一个完整的品牌名，禁止再拆成城市，目前仅上海在招——候选人提及“成都你六姐”时默认按上海查询，其他城市候选人直接告知"该品牌其他城市暂未开店"。（时效：随品牌开城状态变化，开城即失效需更新本条）',
    '成都你六姐是一个完整的品牌名，禁止再拆成城市，目前仅上海在招。候选人提及该品牌时默认按上海查询，其他城市候选人直接告知该品牌其他城市暂未开店。（时效：随品牌开城状态变化，开城即失效需更新本条）'
  ];
  brand_rule constant text := '“成都你六姐”是完整品牌名，名称中的“成都”不代表候选人的求职城市。';
  config record;
  next_red_lines jsonb;
BEGIN
  FOR config IN
    SELECT id, red_lines FROM public.strategy_config
    WHERE is_active AND status IN ('testing', 'released')
      AND jsonb_typeof(red_lines -> 'rules') = 'array'
      AND (red_lines -> 'rules') ?| old_rules
    ORDER BY status DESC -- 与 publish_strategy 一致，先锁 testing
    FOR UPDATE
  LOOP
    SELECT jsonb_set(config.red_lines, '{rules}', jsonb_agg(
      CASE WHEN rule #>> '{}' = ANY(old_rules) THEN to_jsonb(brand_rule) ELSE rule END
      ORDER BY position
    ))
    INTO next_red_lines
    FROM jsonb_array_elements(config.red_lines -> 'rules') WITH ORDINALITY AS item(rule, position);

    UPDATE public.strategy_config SET red_lines = next_red_lines WHERE id = config.id;
    INSERT INTO public.strategy_config_changelog (config_id, field, old_value, new_value, changed_by)
    VALUES (config.id, 'red_lines', config.red_lines, next_red_lines, 'Codex');
  END LOOP;
END
$migration$;
