-- ============================================================
-- Migration: 时段硬约束 + 开场问地址优先 + 多岗位推荐结构化
--
-- 背景：本周飞书 badcase 反馈集中在三类问题——
--   #3 #4 #8：候选人已明确时段/班次约束（如"只能晚上6到12点"），Agent 仍推荐
--              班次完全落在限制外的岗位，或试图扭转候选人的时段。
--   #5 #6：开场阶段追问"倾向的品牌/岗位类型"或先问城市，让候选人产生"像中介"
--          的感觉；现已支持经纬度，应直接问具体地址。
--   #2：推荐多个岗位时，把同一岗位的店名/地址/薪资/班次拆成多条零散消息，
--       或不同岗位的信息交错输出，造成刷屏。
--
-- 本迁移幂等地在所有 strategy_config 的 red_lines / stage_goals 上补充规则：
--   1) red_lines.rules 追加：时段硬约束不得通融推荐。
--   2) trust_building.ctaStrategy 追加：首问优先引导地址。
--   3) trust_building.disallowedActions 追加：开场不问品牌/岗位倾向。
--   4) job_consultation.ctaStrategy 追加：多岗位按"一段一岗位 + 双换行"输出。
--   5) job_consultation.disallowedActions 追加：禁止字段交错输出。
--
-- 设计与既有 strategy_* migration 一致：用 @> 检查幂等。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  -- red_lines.rules 追加项
  new_red_line text :=
    '候选人已明确表达时段/班次硬约束（如"只能晚上X到Y点"、"只做早班"、"只做周末"）时，不得推荐工作时段与该限制无重叠的岗位；当前可推岗位无一与候选人时段重叠时，直接告知暂无合适并调用 invite_to_group 拉群维护，不得通融式推荐或试图扭转候选人时段。';

  -- trust_building.ctaStrategy 追加项
  new_trust_cta text :=
    '首问优先引导候选人发具体地址（商圈/街道/地铁站/地标/详细地址都行），而不是先问城市、品牌或岗位类型——候选人多数从 boss 等渠道带着具体目标来，开场问品牌/岗位倾向会显得像中介；拿到地址后用 geocode 查附近岗位效率更高。';

  -- trust_building.disallowedActions 追加项
  new_trust_disallowed text :=
    '开场阶段主动询问候选人"倾向的品牌""想做哪类岗位""找什么类型的工作"等——候选人通常来自 boss 等招聘平台、心里已有目标岗位，开场追问品牌/岗位倾向会显得像中介、破坏信任。首问应是地址。';

  -- job_consultation.ctaStrategy 追加项
  new_job_cta text :=
    '推荐多个岗位时，每个岗位独立成一段、段间用双换行分隔，一段内写全该岗位的店名/地址/薪资/班次等关键信息；不要把多个岗位的地址、薪资、班次等字段交错输出造成刷屏。';

  -- job_consultation.disallowedActions 追加项
  new_job_disallowed text :=
    '推荐多个岗位时，把同一岗位的地址、薪资、班次、要求等字段拆成多条零散消息轮流发出，或把不同岗位的信息交错输出，导致候选人分不清哪条字段属于哪家店。';

  updated_rules jsonb;
  updated_stages jsonb;
  stage_elem jsonb;
  cta_arr jsonb;
  disallowed_arr jsonb;
  i int;
BEGIN
  FOR rec IN SELECT id, red_lines, stage_goals FROM strategy_config LOOP

    -- ---------- 1) red_lines.rules ----------
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    IF NOT (updated_rules @> jsonb_build_array(new_red_line)) THEN
      updated_rules := updated_rules || to_jsonb(new_red_line);
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        updated_rules
      )
      WHERE id = rec.id;
    END IF;

    -- ---------- 2/3) trust_building 与 4/5) job_consultation ----------
    updated_stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(updated_stages) - 1 LOOP
      stage_elem := updated_stages -> i;

      IF stage_elem ->> 'stage' = 'trust_building' THEN
        -- ctaStrategy
        cta_arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        IF NOT (cta_arr @> jsonb_build_array(new_trust_cta)) THEN
          cta_arr := cta_arr || to_jsonb(new_trust_cta);
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', cta_arr);
        END IF;

        -- disallowedActions
        disallowed_arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        IF NOT (disallowed_arr @> jsonb_build_array(new_trust_disallowed)) THEN
          disallowed_arr := disallowed_arr || to_jsonb(new_trust_disallowed);
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', disallowed_arr);
        END IF;

        updated_stages := jsonb_set(updated_stages, ARRAY[i::text], stage_elem);
      END IF;

      IF stage_elem ->> 'stage' = 'job_consultation' THEN
        -- ctaStrategy
        cta_arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        IF NOT (cta_arr @> jsonb_build_array(new_job_cta)) THEN
          cta_arr := cta_arr || to_jsonb(new_job_cta);
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', cta_arr);
        END IF;

        -- disallowedActions
        disallowed_arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        IF NOT (disallowed_arr @> jsonb_build_array(new_job_disallowed)) THEN
          disallowed_arr := disallowed_arr || to_jsonb(new_job_disallowed);
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', disallowed_arr);
        END IF;

        updated_stages := jsonb_set(updated_stages, ARRAY[i::text], stage_elem);
      END IF;
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
