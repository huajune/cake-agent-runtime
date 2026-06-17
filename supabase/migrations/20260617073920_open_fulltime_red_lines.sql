-- 放开"全职岗位"：更新 strategy_config.red_lines 中两条受影响的红线规则。
--
-- 背景：平台现在同时有全职和兼职岗位（laborForm 字段会返回"全职"）。原红线
-- "禁止表述为全职" 与 "兼职岗位不缴纳社保" 在全职放开后会导致 Agent 答错。
--
-- 处理：对 red_lines.rules 数组做字符串级替换（幂等——替换后旧串不再匹配，
-- WHERE 不会再命中）。仅替换精确匹配的两条旧规则，其余规则原样保留。

UPDATE strategy_config
SET red_lines = jsonb_set(
  red_lines,
  '{rules}',
  (
    SELECT jsonb_agg(
      CASE rule
        WHEN '平台所有岗位按兼职口径，禁止表述为全职；候选人未提及时不得主动反问"想做全职还是兼职"。'
          THEN to_jsonb('岗位用工形式（全职/兼职/小时工/暑假工等）一律按岗位 laborForm 字段如实介绍，禁止编造或互相改写（不得把兼职岗说成全职、也不得把全职岗说成兼职）；候选人未提及全职/兼职偏好时不主动反问"想做全职还是兼职"，按其位置/工种正常推荐。'::text)
        WHEN '已约面阶段问社保/五险一金/公积金，直答"兼职岗位不缴纳社保"；严禁说"以门店为准 / 入职后再确认"。'
          THEN to_jsonb('已约面阶段问社保/五险一金/公积金：兼职岗直答"兼职岗位不缴纳社保"；全职岗按岗位福利字段如实回答，无字段时只说"我帮你确认下"；严禁笼统说"以门店为准 / 入职后再确认"。'::text)
        ELSE to_jsonb(rule)
      END
    )
    FROM jsonb_array_elements_text(red_lines->'rules') AS rule
  )
)
WHERE red_lines->'rules' ? '平台所有岗位按兼职口径，禁止表述为全职；候选人未提及时不得主动反问"想做全职还是兼职"。'
   OR red_lines->'rules' ? '已约面阶段问社保/五险一金/公积金，直答"兼职岗位不缴纳社保"；严禁说"以门店为准 / 入职后再确认"。';
