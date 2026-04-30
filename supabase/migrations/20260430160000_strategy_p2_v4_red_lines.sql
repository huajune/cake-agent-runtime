-- ============================================================
-- Migration: P2 v4 复盘红线下沉
--
-- 背景：v4 主批次 (1fd28284) 仍有 3 条 FAIL（001/005/012）。诊断：
--   1) 001/005：候选人消息含"日期已过 / 改约"等干扰信号时，模型注意力被
--      日期带跑，跳过 precheck 导致 nameFieldGuard 没机会触发。
--   2) 012：两人结伴求职 + 当前门店名额不足时，模型说"可以一起去登记分开"，
--      没主动为第二个人查附近门店。
--
-- 把 candidate-consultation.md 规则 14（加强）/ 18（新增）下沉到
-- strategy_config.red_lines.rules，让其按红线优先级（最高）生效。
--
-- 幂等：用 @> jsonb_build_array 判存，已存在即跳过。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  precheck_distractor_safeguard text :=
    '收资场景注意力兜底红线：候选人消息或聊天历史中出现"日期已过 / 时间过了 / 之前填的不对 / 该重新约 / 4月X日已过"等"日期已过期"信号时，仍属于"约面意向延续"，必须先调 duliday_interview_precheck 拿当前可约时段再继续，不得直接回复"咱们改个时间吧 / 你看哪天方便"等问候选人挑日期。同样：候选人前几轮已给过姓名/电话/年龄等，本轮只新增"日期问题"时，仍要 precheck 一次（取 nameFieldGuard 检查既有姓名是否真名、requiredFieldsToCollectNow 检查是否还有缺字段），严禁因为"看起来资料齐了"就跳过工具直接判断。';

  two_candidates_split text :=
    '两人结伴求职就近分流红线：候选人明确表示"我们两人 / 我和 XX 一起 / 两个人都要 / 朋友也来"等结伴求职意图时，若当前焦点门店名额不足（店长说只能要一个 / 同店职位已被另一人占 / 候选人主动说"那店只剩一个名额"），严禁回复"可以一起去面试，登记分开就行"或"让店长定吧"等敷衍话术。正确动作：本轮主动以当前门店为锚点重新调用 duliday_job_list（带 location + 同品牌或同岗位类型），找出附近 1-3 公里内的同品牌或近邻品牌门店，给出明确"分流方案"（如：A 去当前门店，B 去 X 门店）。附近无可分流门店时，直接告知"目前附近确实只有这家有缺，第二位先调用 invite_to_group 拉群等下一批"。';

  updated_rules jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    IF NOT (updated_rules @> jsonb_build_array(precheck_distractor_safeguard)) THEN
      updated_rules := updated_rules || to_jsonb(precheck_distractor_safeguard);
      changed := true;
    END IF;

    IF NOT (updated_rules @> jsonb_build_array(two_candidates_split)) THEN
      updated_rules := updated_rules || to_jsonb(two_candidates_split);
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
