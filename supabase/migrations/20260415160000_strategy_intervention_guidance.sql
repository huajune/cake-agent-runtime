-- ============================================================
-- Migration: 策略配置追加人工介入相关红线与阶段指引
--
-- 背景：新增了 raise_risk_alert / request_handoff 两个 Agent 工具，
-- 用于替代原有的异步舆情监控 / onboard_followup 监控。本迁移把
-- 调用时机与身份保护要求写入所有策略配置的 red_lines.rules，并向
-- onboard_followup 阶段追加 ctaStrategy/disallowedActions 引导。
--
-- 设计要点：
-- - 幂等：每条 rule/策略追加前都判定是否已存在。
-- - 覆盖范围：所有 strategy_config 行（testing + released），避免
--   上线前的测试版本遗漏指导。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  new_red_lines text[] := ARRAY[
    '候选人出现辱骂、粗俗表达、明确投诉/举报/维权威胁，或情绪连续升级时，必须先调用 raise_risk_alert，再以招募者身份共情回复；严禁直接继续推进任务或复读粗口。',
    '面试/入职跟进阶段出现无法推进的阻塞（找不到门店、到店无人接待、预约冲突、办理入职等），必须调用 request_handoff 转人工，不得自行兜底或继续推进其他任务。',
    '任何回复严禁出现「机器人」「托管」「系统」「自动回复」「AI」等暴露非真人身份的字眼；出现预约失败/系统异常等情况，也只能以招募者口吻自然衔接「我让同事确认一下」。'
  ];
  rule_text text;
  updated_rules jsonb;
  existing_rules jsonb;
  updated_stages jsonb;
  stage_elem jsonb;
  i int;
  new_cta_items text[] := ARRAY[
    '遇到门店定位错乱、到店无人接待、预约信息冲突、入职办理异常等需人工介入的阻塞场景，立即调用 request_handoff，不要继续尝试自行解决。'
  ];
  new_disallowed_items text[] := ARRAY[
    '在回复中暴露「机器人」「托管」「系统」「自动回复」「AI」等非真人身份字眼。'
  ];
  cta_text text;
  disallowed_text text;
  cta_arr jsonb;
  disallowed_arr jsonb;
BEGIN
  FOR rec IN SELECT id, red_lines, stage_goals FROM strategy_config LOOP
    -- ===== 1. 追加 red_lines.rules =====
    existing_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    updated_rules := existing_rules;
    FOREACH rule_text IN ARRAY new_red_lines LOOP
      IF NOT (updated_rules @> jsonb_build_array(rule_text)) THEN
        updated_rules := updated_rules || to_jsonb(rule_text);
      END IF;
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

    -- ===== 2. 追加 stage_goals.stages 中对应阶段的 ctaStrategy / disallowedActions =====
    updated_stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(updated_stages) - 1 LOOP
      stage_elem := updated_stages -> i;

      -- 只对 onboard_followup 阶段追加 CTA
      IF stage_elem ->> 'stage' = 'onboard_followup' THEN
        cta_arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        FOREACH cta_text IN ARRAY new_cta_items LOOP
          IF NOT (cta_arr @> jsonb_build_array(cta_text)) THEN
            cta_arr := cta_arr || to_jsonb(cta_text);
          END IF;
        END LOOP;
        stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', cta_arr);
      END IF;

      -- 所有阶段都追加身份保护 disallowed
      disallowed_arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
      FOREACH disallowed_text IN ARRAY new_disallowed_items LOOP
        IF NOT (disallowed_arr @> jsonb_build_array(disallowed_text)) THEN
          disallowed_arr := disallowed_arr || to_jsonb(disallowed_text);
        END IF;
      END LOOP;
      stage_elem := jsonb_set(stage_elem, '{disallowedActions}', disallowed_arr);

      updated_stages := jsonb_set(updated_stages, ARRAY[i::text], stage_elem);
    END LOOP;

    IF updated_stages IS DISTINCT FROM COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb) THEN
      UPDATE strategy_config
      SET stage_goals = jsonb_set(
        COALESCE(stage_goals, '{}'::jsonb),
        '{stages}',
        updated_stages
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
