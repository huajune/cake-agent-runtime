const GUARDRAIL_RULE_LABELS: Record<string, string> = {
  internal_output_leak: '内部信息泄漏',
  ungrounded_job_recommendation: '岗位推荐未接地',
  tool_failure_success_claim: '工具失败却称成功',
  precheck_blocked_booking_claim: '预检阻断仍承诺可约',
  wait_notice_time_fabrication: '等通知岗位编造时间',
  wait_notice_time_collection: '等通知岗位追问时间',
  confirmed_booking_time_missing: '预约成功漏告知时间',
  confirmed_booking_onsite_script_missing: '预约成功漏到店话术',
  geocode_uncertain_location_claim: '地点不清却下位置结论',
  geocode_ambiguous_candidates_omitted: '地点歧义未列候选城市',
  district_level_distance_claim: '区级定位却报精确距离',
  farther_job_recommended: '有近岗却推荐远岗',
  schedule_filtered_job_recommended: '班次过滤后仍推荐',
  handoff_no_booking_claim: '无预约却称已转人工',
  group_full_without_invite: '未拉群却称群满',
  group_promise_without_invite: '未拉群却称已邀请',
  discriminatory_screening_leak: '敏感筛选条件外露',
  booking_form_field_mismatch: '收资模板字段不匹配',
  salary_fabrication: '薪资信息编造',
  job_shift_polarity_mismatch: '班次早晚说反',
  hourly_salary_value_mismatch: '时薪数值不一致',
  settlement_cycle_mismatch: '结算周期不一致',
  proactive_insurance_policy_mention: '主动提保险政策',
  candidate_name_echo: '直接复述候选人备注名',
  distance_missing: '推荐岗位漏距离',
  group_invite_without_reason: '拉群未说明原因',
  human_service_phrase_leak: '人工客服话术露出',
  repeated_reply: '重复回复',
  repeated_greeting: '重复问候',
  quota_promise: '名额承诺',
  brand_name_violation: '品牌名称错误',
  requested_brand_mismatch: '推荐品牌不符',
  brand_alias_fuzzy_match_ignored: '忽略品牌别名匹配',
  image_description_not_saved: '图片描述未保存',
  provided_booking_fields_ignored: '忽略已提供报名字段',
  system_status_fabrication: '编造系统状态',
  work_content_generalization: '工作内容泛化脑补',

  // LLM reviewer / compact violation types may use semantic finding codes instead of rule ids.
  active_booking_state_conflict: '预约状态冲突',
  false_promises: '虚假承诺',
  job_fact_value_mismatch: '岗位事实数值不一致',
};

const REASON_CODE_LABELS: Record<string, string> = {
  repair_exhausted: '修复后仍未通过',
  risk_intercept: '风险拦截',
};

export function guardrailRuleLabel(ruleId: string): string {
  return GUARDRAIL_RULE_LABELS[ruleId] ?? ruleId;
}

export function guardrailReasonLabel(reasonCode: string): string {
  return REASON_CODE_LABELS[reasonCode] ?? reasonCode;
}

export function guardrailRuleListLabel(ruleIds: string[]): string {
  const labels = [...new Set(ruleIds)].map(guardrailRuleLabel);
  return labels.join('、') || '-';
}

export function guardrailRuleTitle(ruleId: string): string {
  const label = guardrailRuleLabel(ruleId);
  return label === ruleId ? ruleId : `${label}\n${ruleId}`;
}

export function guardrailRuleListTitle(ruleIds: string[]): string {
  return [...new Set(ruleIds)]
    .map((ruleId) => {
      const label = guardrailRuleLabel(ruleId);
      return label === ruleId ? ruleId : `${label}（${ruleId}）`;
    })
    .join('\n');
}
