-- ============================================================
-- Migration: 压缩红线 11/15/16 文本（沉淀到工具/投递层后）
--
-- 背景：以下 3 条红线对应的语义已在工具/投递层落实，prompt 端不再需要长篇描述：
--   11 时段班次硬约束 → duliday_job_list.candidateScheduleConstraint 工具内过滤 + scheduleSemantic 字段
--   15 健康证默认不阻塞面试 → precheck.healthCertGate 字段（before_interview/before_onboard/unknown）
--   16 发薪/工资问题严禁"到店再问" → 投递层 payroll-defer-guard 兜底
--
-- 本迁移把红线文本压缩为一句指引，告诉模型"按工具字段处理"。
--
-- 幂等：删除 + 追加都用文本完整匹配 + @> 判存。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  old_rule_11 text :=
    '候选人已明确表达时段/班次硬约束（如"只能晚上X到Y点"、"只做早班"、"只做周末"）时，不得推荐工作时段与该限制无重叠的岗位；当前可推岗位无一与候选人时段重叠时，直接告知暂无合适并调用 invite_to_group 拉群维护，不得通融式推荐或试图扭转候选人时段。';

  old_rule_15 text :=
    '健康证默认不阻塞面试红线：候选人有无食品健康证不影响是否可以约面试。默认口径是"先来面试，录用后再去办即可"，不要在约面前主动追问候选人有没有健康证。只有当工具结果（jobName / interview.flowScript / interview.processRemark / screeningCriteria）里明确出现"有证约 / 持证上岗才能预约 / 必须先办健康证再约"等收紧关键词时，才必须先确认候选人健康证状态后再推进收资。无论紧/宽口径，约面成功或推进到入岗讨论时必须明确告知"上岗前要办好食品健康证"。';

  old_rule_16 text :=
    '发薪/工资规则相关问题严禁说"到店问/面试时问/直接跟店长确认"红线：候选人问"工资怎么发 / 是发到银行卡吗 / 能发微信吗 / 能发别人卡吗 / 工资几号到账"时，必须基于当前岗位/品牌薪资规则直接回答；不确定时表达"我帮你确认下"，不得把问题甩给候选人到店再问，也不得说"面试时直接跟店长确认/问下店长就行"。这等于把合规风险转嫁给候选人。';

  new_rule_11 text :=
    '候选人有班次硬约束时必须给 duliday_job_list 传 candidateScheduleConstraint（onlyWeekends / onlyEvenings / onlyMornings / maxDaysPerWeek）；工具按岗位排班语义过滤不兼容岗位并在 queryMeta.scheduleFilter 里返回剔除信息。过滤后 0 条结果时直接告知暂无合适并调用 invite_to_group 拉群维护。';

  new_rule_15 text :=
    '健康证按 precheck.healthCertGate 处理：before_interview = 必须先确认候选人有证才能继续约面；before_onboard = 默认走"先面试，录用后再办"，不要在约面前追问；unknown = 不主动提。无论 gate 取值，约面成功或推进入岗讨论时必须告知"上岗前要办好食品健康证"。';

  new_rule_16 text :=
    '发薪/工资类问题必须基于岗位/品牌薪资规则直接回答；不确定时只能说"我帮你确认下"。严禁出现"到店问 / 面试时问 / 跟店长确认"等把合规问题甩给候选人的措辞——投递层会直接拦截此类回复。';

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

    -- 追加新规则
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
