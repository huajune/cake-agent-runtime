-- ============================================================
-- Migration: P2 面试预约硬规则补强
--
-- 背景：P2 回归中暴露两类约面风险：
--   1) 候选人询问今天/当天能否面试时，Agent 可能未先 precheck 就承诺可约。
--   2) Agent 可能把岗位工作时间/候选人可上班时间误当作面试时间。
--
-- 本迁移幂等地在 strategy_config 的 red_lines.rules 与
-- interview_scheduling 阶段策略中补充硬规则。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  same_day_red_line text :=
    '同日面试前置 precheck 红线：候选人询问或表达"今天能面试吗 / 今天去可以吗 / 今天下午可以吗"等同日面试诉求时，必须先调用 duliday_interview_precheck 并传 requestedDate=今天；在 precheck 返回可约且所需字段完整前，严禁承诺今天能约、已安排或直接调用 duliday_interview_booking。';

  work_time_red_line text :=
    '工作时间与面试时间区分红线：岗位的工作时间/workTime/班次只表示上班排班，不等于面试时间；候选人只说"这个时间能上班 / 我工作时间可以"时不得把它当 interviewTime。约面前必须用 duliday_interview_precheck 的 interview.scheduleRule/requestedDate/bookableSlots 确认面试时间，无法确认时先澄清。';

  same_day_cta text :=
    '候选人询问今天/当天是否能面试时，必须先调用 duliday_interview_precheck，并把 requestedDate 设为今天；只有 precheck 明确可约后才能继续收资或预约。';

  work_time_cta text :=
    '区分工作时间和面试时间：岗位 workTime/班次、候选人可上班时间都不能直接作为 interviewTime；约面时间只认 duliday_interview_precheck 返回的 scheduleRule/requestedDate/bookableSlots 或候选人明确确认的面试时间。';

  same_day_disallowed text :=
    '未先调用 duliday_interview_precheck 就回答"今天可以面试 / 今天能约 / 已经安排今天面试"，或直接提交 duliday_interview_booking。';

  work_time_disallowed text :=
    '把岗位工作时间、班次时间、候选人可上班时间当作面试时间提交或对外承诺；工作时间和面试时间不清楚时必须先澄清。';

  updated_rules jsonb;
  updated_stages jsonb;
  stage_elem jsonb;
  cta_arr jsonb;
  disallowed_arr jsonb;
  i int;
BEGIN
  FOR rec IN SELECT id, red_lines, stage_goals FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);

    IF NOT (updated_rules @> jsonb_build_array(same_day_red_line)) THEN
      updated_rules := updated_rules || to_jsonb(same_day_red_line);
    END IF;

    IF NOT (updated_rules @> jsonb_build_array(work_time_red_line)) THEN
      updated_rules := updated_rules || to_jsonb(work_time_red_line);
    END IF;

    IF updated_rules IS DISTINCT FROM COALESCE(rec.red_lines -> 'rules', '[]'::jsonb) THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        updated_rules
      )
      WHERE id = rec.id;
    END IF;

    updated_stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(updated_stages) - 1 LOOP
      stage_elem := updated_stages -> i;

      IF stage_elem ->> 'stage' = 'interview_scheduling' THEN
        cta_arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        IF NOT (cta_arr @> jsonb_build_array(same_day_cta)) THEN
          cta_arr := cta_arr || to_jsonb(same_day_cta);
        END IF;
        IF NOT (cta_arr @> jsonb_build_array(work_time_cta)) THEN
          cta_arr := cta_arr || to_jsonb(work_time_cta);
        END IF;
        stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', cta_arr);

        disallowed_arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        IF NOT (disallowed_arr @> jsonb_build_array(same_day_disallowed)) THEN
          disallowed_arr := disallowed_arr || to_jsonb(same_day_disallowed);
        END IF;
        IF NOT (disallowed_arr @> jsonb_build_array(work_time_disallowed)) THEN
          disallowed_arr := disallowed_arr || to_jsonb(work_time_disallowed);
        END IF;
        stage_elem := jsonb_set(stage_elem, '{disallowedActions}', disallowed_arr);

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
