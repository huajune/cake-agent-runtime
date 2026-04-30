-- ============================================================
-- Migration: 红线去 prompt/工具描述 重复（20 → 14 条）
--
-- 背景：consolidate 后剩的 20 条里，有 6 条与 candidate-consultation.md 全局
-- 工作原则、或 request_handoff / duliday_job_list 工具描述 **逐字重复 / 部分重复**。
-- 红线层应只保留"工具描述/全局原则没法覆盖的纯业务硬底线"，凡是行为指引性的、
-- 对应到具体工具调用的，都应回归到工具描述或主体 prompt 全局原则。
--
-- 重复关系：
--   #9  request_handoff 关键词         → request-handoff.tool.ts 描述已覆盖（interview_result_inquiry / modify_appointment / self_recruited_or_completed 三个 reasonCode 全部列举关键词）
--   #10 未确认城市禁默认               → duliday-job-list.tool.ts 描述已逐字写入（"未确认城市禁默认"段）
--   #12 推荐必须带班次时间             → candidate-consultation.md 全局原则 #12 已扩展（同 PR）
--   #14 时段班次硬约束                  → candidate-consultation.md 全局原则 #11（逐字重复）
--   #19 如实呈现红线（合并版）         → candidate-consultation.md 全局原则 #2 已扩展（同 PR）
--   #20 约面前必须 precheck            → candidate-consultation.md 全局原则 #14（逐字重复）
--
-- 净变化：-6，从 20 条压到 14 条。
--
-- 幂等：删除按文本完整匹配。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  old_rules text[] := ARRAY[
    -- #9 request_handoff 关键词 → 已沉入工具描述
    $rule$候选人本轮提到"刚面试过 / 通过了吗 / 已经办入职 / 店长让我来的 / 我们餐厅找的我 / 想改约时间 / 取消预约"等关键词时，立即调用 request_handoff，不要继续自行推进对话或回避问题。$rule$,

    -- #10 未确认城市禁默认 → 已沉入 duliday_job_list 工具描述
    $rule$未确认城市禁默认：[本轮高置信线索] 与 [会话记忆] 都未给候选人意向城市时，禁止默认任何城市（含上海 / 北京等高频城市）做查岗或品牌承诺；候选人问"你是哪个店招聘"等归属问题时，必须先简短确认"您想找哪个城市的岗位"，不得用反问位置/区域绕开城市归属。$rule$,

    -- #12 推荐必须带班次时间 → 已沉入 candidate-consultation.md 全局原则 #12
    $rule$岗位推荐必须主动告知具体工作班次时间红线：本轮要给候选人具体岗位/门店推荐时，回复必须带上该岗位的上班班次时间段（如"早班 7:30-9:30 / 中班 11:30-14:30"、"工作时间 09:00-18:00"），与门店、薪资、关键要求并列展示。不能只说"早班/晚班/开档/前厅服务员/后厨"等岗位名或时段名就当作交代了班次；更严禁自己没说班次时间却反问候选人"这家距离和班次能不能接受？""你看班次方便吗？"。工具返回的工作时间字段缺失/为空时，如实告知"具体班次到门店面试时再确认下"，不得编造时间。$rule$,

    -- #14 时段班次硬约束 → candidate-consultation.md 全局原则 #11 逐字重复
    $rule$候选人已明确表达时段/班次硬约束（如"只能晚上X到Y点"、"只做早班"、"只做周末"、"每周最多两天"、"做一休一"）时，推荐岗位必须与该时段重叠；当前可推岗位无一满足时直接告知暂无合适并拉群维护，不得用不匹配时段的岗位凑数，也不得试图扭转候选人时段。岗位排班是"每天/做六休一/周一至周日/早开晚结"等强排班要求时，按字面理解，不能包装成"周末可做"或"晚班可排"。$rule$,

    -- #19 如实呈现红线（consolidate 合并版） → 已沉入 candidate-consultation.md 全局原则 #2
    $rule$如实呈现红线：禁止猜测或推断品牌名称；禁止未经工具查询就回答品牌分布、薪资、班次等事实问题，也禁止编造或美化岗位事实，一切以工具返回为准；严禁为了推荐成功而扭曲或重新诠释候选人已明确表达的意向（品牌、岗位类型、城市、区域、班次、薪资等），意向超出当前可推范围时直接如实告知不匹配，不得用替代品牌/区域/岗位假装满足。$rule$,

    -- #20 约面前必须 precheck（consolidate 合并版） → candidate-consultation.md 全局原则 #14 逐字重复
    $rule$约面/收资动作前必须先调 duliday_interview_precheck 红线：以下任一情况都必须先 precheck 拿当前可约时段、bookingChecklist.requiredFieldsToCollectNow、nameFieldGuard 后再推进——(a) 候选人表达约面意向（"需要面试吗 / 帮我约 / 这家可以 / 几号能面 / 怎么报名"等）；(b) 候选人指定具体日期（含"今天 / 明天 / 后天 / X 月 X 日"），同日诉求传 requestedDate=今天；(c) 聊天历史出现"日期已过 / 时间过了 / 之前填的不对 / 该重新约"等过期信号，仍属于约面意向延续，必须 precheck 一次；(d) 候选人只说"这个时间能上班 / 我工作时间可以"——岗位 workTime/班次只是上班排班，不等于面试时间，必须用 interview.scheduleRule/bookableSlots 确认。未拿到工具结果前，严禁直接发资料模板、问"叫什么/电话多少"、承诺"今天/明天能约"、把候选人转入"挑日期"流程，或调用 duliday_interview_booking。$rule$
  ];
  updated_rules jsonb;
  filtered_rules jsonb;
  rule_elem jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    filtered_rules := '[]'::jsonb;
    FOR rule_elem IN SELECT * FROM jsonb_array_elements(updated_rules) LOOP
      IF (rule_elem #>> '{}') = ANY(old_rules) THEN
        changed := true;
      ELSE
        filtered_rules := filtered_rules || rule_elem;
      END IF;
    END LOOP;

    IF changed THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        filtered_rules
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
