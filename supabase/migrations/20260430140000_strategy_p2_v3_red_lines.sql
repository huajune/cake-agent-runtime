-- ============================================================
-- Migration: P2 v3 复盘红线下沉 + prod-only 历史漂移修复
--
-- 背景：
--   1) v3 批次 a1f4a1d4 中 6/12 case 仍 FAIL，根因是补丁仅写在 final-check.md
--      （回复前自检），生成阶段已经走错；本迁移把 4 条硬规则下沉到
--      strategy_config.red_lines.rules（系统注入的最高优先级层）。
--   2) 历史漂移：test (gaovfitvetoojkvtalxy) released v6 含 23 条 rules，
--      prod (uvmbxcilpteaiizplcyp) released v10 仅 21 条，差 2 条
--      ("禁止未经工具查询" + "禁止暴露技术细节")；本迁移顺手回填到 prod。
--
-- 幂等：每条都用 @> jsonb_build_array(...) 判存，已存在就跳过，可安全
-- 重复执行；test 与 prod 同套 SQL。
-- 规模假设：strategy_config 当前是小表，因此逐行检查 red_lines.rules 的全表扫描可接受；
-- 若后续增长为大表，再为 red_lines 或 rules 表达式补 GIN 索引。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  -- v3 复盘 4 条新红线
  precheck_before_collection text :=
    '进入收资场景前必须先 duliday_interview_precheck 红线：候选人表达约面意向（"需要面试吗 / 帮我约 / 这家可以 / 几号能面 / 怎么报名"等）后，第一步必须先调 duliday_interview_precheck。未拿到工具结果前，严禁直接发资料模板、问"叫什么/电话多少"、承诺"今天/明天能约"或把候选人转入"挑日期"流程。precheck 返回的 bookingChecklist.requiredFieldsToCollectNow 与 nameFieldGuard 是后续收资和提交 booking 的唯一字段依据。';

  parallel_date_health_cert text :=
    '约面前必须并列核验日期+健康证两件事红线：候选人表达约面意向、或刚完成约面时间确认时，本轮回复必须同时确认（a）具体可约时段（来自 precheck.interview）和（b）食品健康证状态。两件事都要在同一轮里说清，不得只确认其一就推进收资。常见违规：聚焦"今天截止/改约日期"导致丢健康证；或反过来只问健康证不给具体时段。';

  payroll_no_defer_to_store text :=
    '发薪/工资规则相关问题严禁说"到店问/面试时问/直接跟店长确认"红线：候选人问"工资怎么发 / 是发到银行卡吗 / 能发微信吗 / 能发别人卡吗 / 工资几号到账"时，必须基于当前岗位/品牌薪资规则直接回答；不确定时表达"我帮你确认下"，不得把问题甩给候选人到店再问，也不得说"面试时直接跟店长确认/问下店长就行"。这等于把合规风险转嫁给候选人。';

  job_recommend_explicit_shift text :=
    '岗位推荐必须主动告知具体工作班次时间红线：本轮要给候选人具体岗位/门店推荐时，回复必须带上该岗位的上班班次时间段（如"早班 7:30-9:30 / 中班 11:30-14:30"、"工作时间 09:00-18:00"），与门店、薪资、关键要求并列展示。不能只说"早班/晚班/开档/前厅服务员/后厨"等岗位名或时段名就当作交代了班次；更严禁自己没说班次时间却反问候选人"这家距离和班次能不能接受？""你看班次方便吗？"。工具返回的工作时间字段缺失/为空时，如实告知"具体班次到门店面试时再确认下"，不得编造时间。';

  -- prod 历史漂移：test 已有但 prod 缺失的 2 条
  no_unverified_facts text :=
    '禁止未经工具查询就回答品牌分布、薪资、班次等事实问题，也禁止编造或美化岗位事实，一切必须以工具返回为准';

  no_internal_terms text :=
    '禁止暴露技术细节（系统/接口/数据库/API/参数/模型/后台）';

  updated_rules jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    IF NOT (updated_rules @> jsonb_build_array(precheck_before_collection)) THEN
      updated_rules := updated_rules || to_jsonb(precheck_before_collection);
      changed := true;
    END IF;

    IF NOT (updated_rules @> jsonb_build_array(parallel_date_health_cert)) THEN
      updated_rules := updated_rules || to_jsonb(parallel_date_health_cert);
      changed := true;
    END IF;

    IF NOT (updated_rules @> jsonb_build_array(payroll_no_defer_to_store)) THEN
      updated_rules := updated_rules || to_jsonb(payroll_no_defer_to_store);
      changed := true;
    END IF;

    IF NOT (updated_rules @> jsonb_build_array(job_recommend_explicit_shift)) THEN
      updated_rules := updated_rules || to_jsonb(job_recommend_explicit_shift);
      changed := true;
    END IF;

    IF NOT (updated_rules @> jsonb_build_array(no_unverified_facts)) THEN
      updated_rules := updated_rules || to_jsonb(no_unverified_facts);
      changed := true;
    END IF;

    IF NOT (updated_rules @> jsonb_build_array(no_internal_terms)) THEN
      updated_rules := updated_rules || to_jsonb(no_internal_terms);
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
