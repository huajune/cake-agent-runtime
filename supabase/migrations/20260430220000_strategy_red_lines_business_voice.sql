-- ============================================================
-- Migration: 红线 11/15/16 改为纯业务声明（去实现引用）
--
-- 背景：之前 20260430200000 把红线 11/15/16 写成了"按工具字段 X 处理"的
-- 实现引用风格（如 candidateScheduleConstraint / healthCertGate / 投递层会拦截）。
-- 红线应是纯业务声明，模型读到后能直接照做，不应引用工具入参/返回字段名。
--
-- 同时：投递层目前只对 output_leak（内部实现泄漏）做静默丢弃，发薪甩锅
-- 措辞已不在投递层兜底，因此红线 16 里"投递层会直接拦截此类回复"是过期表述。
--
-- 幂等：删除按文本完整匹配，新增按 @> 判存。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  old_rule_11 text :=
    '候选人有班次硬约束时必须给 duliday_job_list 传 candidateScheduleConstraint（onlyWeekends / onlyEvenings / onlyMornings / maxDaysPerWeek）；工具按岗位排班语义过滤不兼容岗位并在 queryMeta.scheduleFilter 里返回剔除信息。过滤后 0 条结果时直接告知暂无合适并调用 invite_to_group 拉群维护。';

  old_rule_15 text :=
    '健康证按 precheck.healthCertGate 处理：before_interview = 必须先确认候选人有证才能继续约面；before_onboard = 默认走"先面试，录用后再办"，不要在约面前追问；unknown = 不主动提。无论 gate 取值，约面成功或推进入岗讨论时必须告知"上岗前要办好食品健康证"。';

  old_rule_16 text :=
    '发薪/工资类问题必须基于岗位/品牌薪资规则直接回答；不确定时只能说"我帮你确认下"。严禁出现"到店问 / 面试时问 / 跟店长确认"等把合规问题甩给候选人的措辞——投递层会直接拦截此类回复。';

  new_rule_11 text :=
    '候选人已明确表达时段/班次硬约束（如"只能晚上X到Y点"、"只做早班"、"只做周末"、"每周最多两天"、"做一休一"）时，推荐岗位必须与该时段重叠；当前可推岗位无一满足时直接告知暂无合适并拉群维护，不得用不匹配时段的岗位凑数，也不得试图扭转候选人时段。岗位排班是"每天/做六休一/周一至周日/早开晚结"等强排班要求时，按字面理解，不能包装成"周末可做"或"晚班可排"。';

  new_rule_15 text :=
    '健康证默认不阻塞面试：默认走"先来面试，录用后再去办"路径，约面前不主动追问候选人有没有健康证。仅当当前岗位明确要求"持证才能预约/有证才能约"时才前置确认；无证时如实说明"这家要求先有证才能约"并给办证建议。约面成功或推进入岗讨论时必须告知"上岗前要办好食品健康证"。';

  new_rule_16 text :=
    '发薪/工资类问题必须基于岗位/品牌薪资规则直接回答；不确定时只能说"我帮你确认下"。严禁回复"到店问 / 面试时问 / 跟店长确认"等把合规问题甩给候选人的措辞——这等于把合规风险转嫁给候选人。';

  updated_rules jsonb;
  filtered_rules jsonb;
  rule_elem jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    -- 删除旧规则（按文本完整匹配）
    FOR rule_elem IN SELECT * FROM jsonb_array_elements(updated_rules) LOOP
      IF rule_elem::text = to_jsonb(old_rule_11)::text
        OR rule_elem::text = to_jsonb(old_rule_15)::text
        OR rule_elem::text = to_jsonb(old_rule_16)::text THEN
        changed := true;
      END IF;
    END LOOP;

    IF changed THEN
      filtered_rules := '[]'::jsonb;
      FOR rule_elem IN SELECT * FROM jsonb_array_elements(updated_rules) LOOP
        IF rule_elem::text <> to_jsonb(old_rule_11)::text
          AND rule_elem::text <> to_jsonb(old_rule_15)::text
          AND rule_elem::text <> to_jsonb(old_rule_16)::text THEN
          filtered_rules := filtered_rules || rule_elem;
        END IF;
      END LOOP;
      updated_rules := filtered_rules;
    END IF;

    -- 追加业务声明版
    IF NOT (updated_rules @> jsonb_build_array(new_rule_11)) THEN
      updated_rules := updated_rules || to_jsonb(new_rule_11);
      changed := true;
    END IF;
    IF NOT (updated_rules @> jsonb_build_array(new_rule_15)) THEN
      updated_rules := updated_rules || to_jsonb(new_rule_15);
      changed := true;
    END IF;
    IF NOT (updated_rules @> jsonb_build_array(new_rule_16)) THEN
      updated_rules := updated_rules || to_jsonb(new_rule_16);
      changed := true;
    END IF;

    IF changed THEN
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
