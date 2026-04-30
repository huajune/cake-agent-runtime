-- ============================================================
-- Migration: 健康证业务口径修正 — 默认宽口径
--
-- 背景：运营拍板：健康证一般不要求面试时就有；岗位数据里明确出现"有证约"
-- 等收紧字段时才收紧。之前 20260430140000 落的"约面前必须并列核验日期+
-- 健康证两件事红线"过于严格，与运营默认口径冲突。
--
-- 本迁移：
--   1) 删除旧的"并列核验"红线
--   2) 写入"健康证默认不阻塞面试"新红线
--
-- 幂等：删除按文本完整匹配；新增按 @> 判存。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  old_parallel_check text :=
    '约面前必须并列核验日期+健康证两件事红线：候选人表达约面意向、或刚完成约面时间确认时，本轮回复必须同时确认（a）具体可约时段（来自 precheck.interview）和（b）食品健康证状态。两件事都要在同一轮里说清，不得只确认其一就推进收资。常见违规：聚焦"今天截止/改约日期"导致丢健康证；或反过来只问健康证不给具体时段。';

  new_health_cert_default_loose text :=
    '健康证默认不阻塞面试红线：候选人有无食品健康证不影响是否可以约面试。默认口径是"先来面试，录用后再去办即可"，不要在约面前主动追问候选人有没有健康证。只有当工具结果（jobName / interview.flowScript / interview.processRemark / screeningCriteria）里明确出现"有证约 / 持证上岗才能预约 / 必须先办健康证再约"等收紧关键词时，才必须先确认候选人健康证状态后再推进收资。无论紧/宽口径，约面成功或推进到入岗讨论时必须明确告知"上岗前要办好食品健康证"。';

  updated_rules jsonb;
  filtered_rules jsonb;
  rule_elem jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    -- 1) 删除旧规则
    IF updated_rules @> jsonb_build_array(old_parallel_check) THEN
      filtered_rules := '[]'::jsonb;
      FOR rule_elem IN SELECT * FROM jsonb_array_elements(updated_rules) LOOP
        IF rule_elem::text <> to_jsonb(old_parallel_check)::text THEN
          filtered_rules := filtered_rules || rule_elem;
        END IF;
      END LOOP;
      updated_rules := filtered_rules;
      changed := true;
    END IF;

    -- 2) 追加新规则
    IF NOT (updated_rules @> jsonb_build_array(new_health_cert_default_loose)) THEN
      updated_rules := updated_rules || to_jsonb(new_health_cert_default_loose);
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
