-- ============================================================
-- Migration: 修正上一个迁移中错误塞入 red_lines 的执行指令
--
-- 背景：20260415160000_strategy_intervention_guidance.sql 把两条「必须
-- 调用某工具」的执行规则加到了 red_lines.rules。但 red_lines 的定位是
-- 业务/品牌/合规红线（应禁行为），而不是系统执行指令。
-- 「遇 X 调用 Y 工具」属于阶段策略（ctaStrategy）和工具手册（prompt）
-- 的范畴，已经在 candidate-consultation.md 与 stage_goals 中覆盖。
--
-- 本次动作：把两条执行类规则从 red_lines.rules 中移除。身份保护那一条
-- （禁暴露机器人/托管/系统字眼）属于合理的品牌红线，保留。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  rules_to_remove text[] := ARRAY[
    '候选人出现辱骂、粗俗表达、明确投诉/举报/维权威胁，或情绪连续升级时，必须先调用 raise_risk_alert，再以招募者身份共情回复；严禁直接继续推进任务或复读粗口。',
    '面试/入职跟进阶段出现无法推进的阻塞（找不到门店、到店无人接待、预约冲突、办理入职等），必须调用 request_handoff 转人工，不得自行兜底或继续推进其他任务。'
  ];
  rule_text text;
  existing_rules jsonb;
  updated_rules jsonb;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    existing_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    updated_rules := existing_rules;

    FOREACH rule_text IN ARRAY rules_to_remove LOOP
      updated_rules := (
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        FROM jsonb_array_elements(updated_rules) AS value
        WHERE value <> to_jsonb(rule_text)
      );
    END LOOP;

    IF updated_rules IS DISTINCT FROM existing_rules THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        updated_rules
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
