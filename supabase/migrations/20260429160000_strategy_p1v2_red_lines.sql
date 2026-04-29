-- ============================================================
-- Migration: P1 v2 评测复盘红线调整（R-17 / R-18 新增 + R-13 改写）
--
-- 背景：2026-04-29 P1 v2 用例测试（batch=9adf38ef）跑完后人工评审发现：
--   - t8hr0qkv / e3rvo7sv：无岗后仍引导换品牌/跨城（duliday-job-list 工具描述
--     里写的"无岗动作链"未生效，需要升级为红线）
--   - 43wkjdd4：候选人问"哪个店"时未先澄清城市/品牌（job-list 工具描述里写的
--     "未确认城市禁默认"未生效，需升级为红线）
--   - 56tivr6s：候选人答"没有"健康证时被误读成"没做过类似工作"，没说"面试通
--     过后再办"——R-13 表述不够明确，强化触发条件与必须主动告知的内容
--
-- 本迁移幂等：
--   1) 新增 R-17 "无岗收口禁追问换品牌/换地区/换城市"
--   2) 新增 R-18 "未确认城市禁默认进入查岗或品牌承诺"
--   3) 改写 R-13 "健康证业务口径"：补全否定表达识别 + 必须主动告知"面试通过后再办"
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  -- 旧 R-13（来自 20260429140000_strategy_p1_red_lines.sql），需被替换
  old_r13 text :=
    '健康证业务口径：当前岗位默认都需要健康证，询问候选人时只用"有 / 无"两选；候选人答"无"时默认面试通过后再办，不得让候选人先办再来面试（岗位明确硬性要求面试前持证除外）。';

  -- 新 R-13：强化否定识别 + 必须主动告知
  new_r13 text :=
    '健康证业务口径：当前岗位默认都需要健康证。询问候选人健康证状态时只用"有 / 无"两选；候选人回答"没有 / 无 / 还没办 / 没办过"等否定表达时，必须直接识别为"无健康证"并主动告知"面试通过后再去办即可"，不得让候选人先办再来面试，也不得把"没有"误读成"没做过类似工作"等其他含义（岗位 screeningCriteria 明确硬性要求面试前持证除外）。';

  -- R-17 无岗收口禁追问
  new_r17 text :=
    '无岗收口红线：duliday_job_list 在候选人明确范围内返回 0 条，且已合理放宽过一次（同城邻区 / 同品牌邻店 / 放宽距离）仍 0 时，必须直接告知"暂时没有合适岗位"并按场景调用 invite_to_group 收口；严禁继续反问候选人"换个地区 / 换个品牌 / 换个城市看看"。候选人主动表达扩张意愿前不再继续扩查。';

  -- R-18 未确认城市禁默认
  new_r18 text :=
    '未确认城市禁默认：[本轮高置信线索] 与 [会话记忆] 都未给候选人意向城市时，禁止默认任何城市（含上海 / 北京等高频城市）做查岗或品牌承诺；候选人问"你是哪个店招聘"等归属问题时，必须先简短确认"您想找哪个城市的岗位"，不得用反问位置/区域绕开城市归属。';

  rules jsonb;
  filtered_rules jsonb;
  rule_elem jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    -- Step 1: 移除旧 R-13（如果存在）
    IF rules @> jsonb_build_array(old_r13) THEN
      filtered_rules := '[]'::jsonb;
      FOR rule_elem IN SELECT * FROM jsonb_array_elements(rules) LOOP
        IF rule_elem #>> '{}' <> old_r13 THEN
          filtered_rules := filtered_rules || rule_elem;
        END IF;
      END LOOP;
      rules := filtered_rules;
      changed := true;
    END IF;

    -- Step 2: 追加新 R-13 / R-17 / R-18（如果不存在）
    IF NOT (rules @> jsonb_build_array(new_r13)) THEN
      rules := rules || to_jsonb(new_r13);
      changed := true;
    END IF;
    IF NOT (rules @> jsonb_build_array(new_r17)) THEN
      rules := rules || to_jsonb(new_r17);
      changed := true;
    END IF;
    IF NOT (rules @> jsonb_build_array(new_r18)) THEN
      rules := rules || to_jsonb(new_r18);
      changed := true;
    END IF;

    IF changed THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        rules
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
