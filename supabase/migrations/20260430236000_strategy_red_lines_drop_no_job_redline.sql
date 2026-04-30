-- ============================================================
-- Migration: 删除"无岗收口红线"（已沉入 duliday_job_list 工具描述）
--
-- 红线 #9 "无岗收口红线" 对应 duliday-job-list.tool.ts 工具描述里
-- "无岗时的动作链"（DESCRIPTION 内 1549-1554 行附近），五条子规则逐字覆盖：
--   1) 第一次 0 条放宽一次
--   2) 仍 0 条直接告知 + invite_to_group
--   3) 严禁反问"换地区/换品牌/换城市"
--   4) 候选人主动追问也适用
--   5) 打破历史轨迹
-- 红线层不再保留重复声明。
--
-- 净变化：-1，从 14 条压到 13 条。
-- 幂等：删除按文本完整匹配。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  old_rules text[] := ARRAY[
    $rule$无岗收口红线：duliday_job_list 在候选人明确范围内返回 0 条，且已合理放宽过一次（同城邻区 / 同品牌邻店 / 放宽距离）仍 0 时，必须直接告知"暂时没有合适岗位"并按场景调用 invite_to_group 收口；严禁继续反问候选人"换个地区 / 换个品牌 / 换个城市看看"。**候选人主动追问"别的地区有吗 / 别的品牌呢 / 还有其他吗"时本红线同样适用——必须基于本轮工具结果直接告知"该品牌/城市暂时无岗"，不得借候选人的追问展开"其他品牌可以吗 / 看看长沙吗 / 上海杭州看看"等扩张推荐**；即使历史轨迹里 Agent 自己上一轮提议过换品牌/换地区，本轮也必须打破这条轨迹直接收口，不得顺承延续。候选人明确表达扩张意愿前不再继续扩查。$rule$
  ];
  updated_rules jsonb;
  filtered_rules jsonb;
  rule_elem jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    filtered_rules := '[]'::jsonb;
    FOR rule_elem IN SELECT * FROM jsonb_array_elements(updated_rules) LOOP
      IF (rule_elem #>> '{}') = ANY(old_rules) THEN
        changed := true;
      ELSE
        filtered_rules := filtered_rules || rule_elem;
      END IF;
    END LOOP;

    IF changed THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        filtered_rules
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
