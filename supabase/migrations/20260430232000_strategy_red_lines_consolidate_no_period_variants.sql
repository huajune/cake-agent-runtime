-- ============================================================
-- Migration: 红线合并补丁 — 清理无句末句号的两个旧变体
--
-- 背景：20260430230000_strategy_red_lines_consolidate.sql 删除了 13 条旧 rules，
-- 但其中 2 条在历史 strategy_config record（test v1-v6 / prod 部分 record）里
-- 是 **没有句末句号** 的变体（baseline 时期写的）：
--   - "禁止承诺具体保险缴纳细节，引导候选人到店确认"   (无 "。")
--   - "禁止自行猜测或推断品牌名称"                       (无 "。")
-- 上一支 migration 用带句号的字面量做完整匹配，因此这些 record 没被删干净。
--
-- 本迁移：补删两个无句号变体，使所有 strategy_config record 都收敛到
-- consolidate 后的 20 条目标态。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  old_rules text[] := ARRAY[
    $rule$禁止承诺具体保险缴纳细节，引导候选人到店确认$rule$,
    $rule$禁止自行猜测或推断品牌名称$rule$
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
