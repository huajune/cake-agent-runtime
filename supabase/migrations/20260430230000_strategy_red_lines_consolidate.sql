-- ============================================================
-- Migration: 红线合并去矛盾（29 → 20 条）
--
-- 问题：DB 红线累积到 29 条，但其中存在两类垃圾——
--   1) 矛盾红线：
--      - 健康证强口径"必须先问有/无"（20260429160000_strategy_p1v2_red_lines.sql 引入）
--        与 20260430180000_strategy_health_cert_default_loose.sql 的运营拍版宽口径
--        "默认不阻塞面试，约面前不主动问"直接打架。运营拍板宽口径，删强口径。
--      - 保险细节"引导候选人到店确认"（baseline 历史遗留）与 P2 v3 红线
--        "已约面追问社保 → 直答兼职岗位不缴纳社保"打架，后者明确禁止"到店再问"。
--        删历史遗留版本。
--   2) 主题重叠：
--      - 兼职口径分散在 2 条
--      - 拟人化/技术细节保密分散在 2 条
--      - 如实呈现（不猜品牌 / 不扭曲意向 / 不编造事实）分散在 3 条
--      - precheck 前置（同日面试 / 工作时间≠面试时间 / 收资前 / 日期过期兜底）分散在 4 条
--
-- 本迁移：
--   - 删除 13 条旧 rules（2 条矛盾 + 11 条主题重叠源）
--   - 追加 4 条合并版（拟人化保密 / 兼职口径 / 如实呈现 / precheck 前置总则）
--   - 净变化：-13 + 4 = -9，从 29 条压到 20 条
--
-- 幂等：删除按文本完整匹配（rule #>> '{}' 等值），追加用 @> 判存。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  -- 旧规则（待删除，13 条）
  old_rules text[] := ARRAY[
    -- 矛盾源 ×2
    $rule$禁止承诺具体保险缴纳细节，引导候选人到店确认。$rule$,
    $rule$健康证业务口径：当前岗位默认都需要健康证。询问候选人健康证状态时只用"有 / 无"两选；候选人回答"没有 / 无 / 还没办 / 没办过"等否定表达时，必须直接识别为"无健康证"并主动告知"面试通过后再去办即可"，不得让候选人先办再来面试，也不得把"没有"误读成"没做过类似工作"等其他含义（岗位 screeningCriteria 明确硬性要求面试前持证除外）。$rule$,
    -- 兼职口径主题（合 2→1）
    $rule$禁止将岗位表述为全职，当前岗位统一按兼职口径沟通。$rule$,
    $rule$禁止主动询问候选人是否做全职偏好；平台所有岗位统一按兼职口径，候选人未提及全职时不得主动反问"想做全职还是兼职"。$rule$,
    -- 拟人化/保密主题（合 2→1）
    $rule$任何回复严禁出现「机器人」「托管」「系统」「自动回复」「AI」等暴露非真人身份的字眼；出现预约失败/系统异常等情况，也只能以招募者口吻自然衔接「我让同事确认一下」。$rule$,
    $rule$禁止暴露技术细节（系统/接口/数据库/API/参数/模型/后台）$rule$,
    -- 如实呈现主题（合 3→1）
    $rule$禁止自行猜测或推断品牌名称。$rule$,
    $rule$严禁为了推荐成功而扭曲或重新诠释候选人已明确表达的意向（品牌、岗位类型、城市、区域、班次、薪资等）；当候选人意向超出当前可推范围时，直接如实告知不匹配，不得用替代品牌、区域或岗位假装满足原意向。$rule$,
    $rule$禁止未经工具查询就回答品牌分布、薪资、班次等事实问题，也禁止编造或美化岗位事实，一切必须以工具返回为准$rule$,
    -- precheck 前置主题（合 4→1）
    $rule$同日面试前置 precheck 红线：候选人询问或表达"今天能面试吗 / 今天去可以吗 / 今天下午可以吗"等同日面试诉求时，必须先调用 duliday_interview_precheck 并传 requestedDate=今天；在 precheck 返回可约且所需字段完整前，严禁承诺今天能约、已安排或直接调用 duliday_interview_booking。$rule$,
    $rule$工作时间与面试时间区分红线：岗位的工作时间/workTime/班次只表示上班排班，不等于面试时间；候选人只说"这个时间能上班 / 我工作时间可以"时不得把它当 interviewTime。约面前必须用 duliday_interview_precheck 的 interview.scheduleRule/requestedDate/bookableSlots 确认面试时间，无法确认时先澄清。$rule$,
    $rule$进入收资场景前必须先 duliday_interview_precheck 红线：候选人表达约面意向（"需要面试吗 / 帮我约 / 这家可以 / 几号能面 / 怎么报名"等）后，第一步必须先调 duliday_interview_precheck。未拿到工具结果前，严禁直接发资料模板、问"叫什么/电话多少"、承诺"今天/明天能约"或把候选人转入"挑日期"流程。precheck 返回的 bookingChecklist.requiredFieldsToCollectNow 与 nameFieldGuard 是后续收资和提交 booking 的唯一字段依据。$rule$,
    $rule$收资场景注意力兜底红线：候选人消息或聊天历史中出现"日期已过 / 时间过了 / 之前填的不对 / 该重新约 / 4月X日已过"等"日期已过期"信号时，仍属于"约面意向延续"，必须先调 duliday_interview_precheck 拿当前可约时段再继续，不得直接回复"咱们改个时间吧 / 你看哪天方便"等问候选人挑日期。同样：候选人前几轮已给过姓名/电话/年龄等，本轮只新增"日期问题"时，仍要 precheck 一次（取 nameFieldGuard 检查既有姓名是否真名、requiredFieldsToCollectNow 检查是否还有缺字段），严禁因为"看起来资料齐了"就跳过工具直接判断。$rule$
  ];

  -- 新规则（追加，4 条合并版）
  new_rule_part_time text :=
    $rule$平台所有岗位统一按兼职口径沟通，禁止表述为全职；候选人未提及全职/兼职偏好时不得主动反问"想做全职还是兼职"。$rule$;

  new_rule_persona text :=
    $rule$招募者拟人化与保密：回复严禁出现「机器人」「托管」「系统」「自动回复」「AI」等暴露非真人身份的字眼，也禁止暴露任何技术细节（接口/数据库/API/参数/模型/后台）；预约失败/系统异常等情况，只能以招募者口吻自然衔接「我让同事确认一下」。$rule$;

  new_rule_truthful text :=
    $rule$如实呈现红线：禁止猜测或推断品牌名称；禁止未经工具查询就回答品牌分布、薪资、班次等事实问题，也禁止编造或美化岗位事实，一切以工具返回为准；严禁为了推荐成功而扭曲或重新诠释候选人已明确表达的意向（品牌、岗位类型、城市、区域、班次、薪资等），意向超出当前可推范围时直接如实告知不匹配，不得用替代品牌/区域/岗位假装满足。$rule$;

  new_rule_precheck text :=
    $rule$约面/收资动作前必须先调 duliday_interview_precheck 红线：以下任一情况都必须先 precheck 拿当前可约时段、bookingChecklist.requiredFieldsToCollectNow、nameFieldGuard 后再推进——(a) 候选人表达约面意向（"需要面试吗 / 帮我约 / 这家可以 / 几号能面 / 怎么报名"等）；(b) 候选人指定具体日期（含"今天 / 明天 / 后天 / X 月 X 日"），同日诉求传 requestedDate=今天；(c) 聊天历史出现"日期已过 / 时间过了 / 之前填的不对 / 该重新约"等过期信号，仍属于约面意向延续，必须 precheck 一次；(d) 候选人只说"这个时间能上班 / 我工作时间可以"——岗位 workTime/班次只是上班排班，不等于面试时间，必须用 interview.scheduleRule/bookableSlots 确认。未拿到工具结果前，严禁直接发资料模板、问"叫什么/电话多少"、承诺"今天/明天能约"、把候选人转入"挑日期"流程，或调用 duliday_interview_booking。$rule$;

  updated_rules jsonb;
  filtered_rules jsonb;
  rule_elem jsonb;
  old_text text;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    -- 删除 13 条旧规则
    filtered_rules := '[]'::jsonb;
    FOR rule_elem IN SELECT * FROM jsonb_array_elements(updated_rules) LOOP
      IF (rule_elem #>> '{}') = ANY(old_rules) THEN
        changed := true;
      ELSE
        filtered_rules := filtered_rules || rule_elem;
      END IF;
    END LOOP;
    updated_rules := filtered_rules;

    -- 追加 4 条新规则（按 @> 判存）
    IF NOT (updated_rules @> jsonb_build_array(new_rule_part_time)) THEN
      updated_rules := updated_rules || to_jsonb(new_rule_part_time);
      changed := true;
    END IF;
    IF NOT (updated_rules @> jsonb_build_array(new_rule_persona)) THEN
      updated_rules := updated_rules || to_jsonb(new_rule_persona);
      changed := true;
    END IF;
    IF NOT (updated_rules @> jsonb_build_array(new_rule_truthful)) THEN
      updated_rules := updated_rules || to_jsonb(new_rule_truthful);
      changed := true;
    END IF;
    IF NOT (updated_rules @> jsonb_build_array(new_rule_precheck)) THEN
      updated_rules := updated_rules || to_jsonb(new_rule_precheck);
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
