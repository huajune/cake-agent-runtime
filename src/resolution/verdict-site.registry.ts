/** P11 允许确定性代码在事实裁决点持有的全部权力类别；没有 semantic_verdict。 */
export const VERDICT_SITE_AUTHORITIES = [
  'structural_gate',
  'closed_form',
  'notary',
  'hint',
] as const;

export type VerdictSiteAuthority = (typeof VERDICT_SITE_AUTHORITIES)[number];
export type VerdictSiteEffect =
  | 'reject'
  | 'supersede'
  | 'mark_missing'
  | 'needs_confirmation'
  | 'advisory';

export interface VerdictSiteRegistration {
  id: string;
  authority: VerdictSiteAuthority;
  effect: VerdictSiteEffect;
  /** `repo-relative-path#symbol-or-call-site`，供 review 与静态断言定位。 */
  source: string;
  /** 为什么该调用点没有越过 P11 的确定性权力边界。 */
  rationale: string;
}

/**
 * 候选人资料与收资链的在产裁决点注册表。
 *
 * 登记对象按“能造成什么权力效果”而不是按目录归类。新增 reject / supersede / 判缺位前，
 * 必须先在这里选择四种合法身份之一；若四类都不适用，确定性代码就没有该裁决权。
 */
export const VERDICT_SITE_REGISTRY = [
  {
    id: 'collection_citation_verification',
    authority: 'notary',
    effect: 'reject',
    source: 'src/resolution/notary/citation-verifier.ts#verifyCitation',
    rationale: '候选人语料与模型 quote 两边均为已知字符串，只做逐字出处核验。',
  },
  {
    id: 'collection_field_value_shape',
    authority: 'closed_form',
    effect: 'reject',
    source: 'src/resolution/candidate/value-shape.ts#isValidCandidateFieldShape',
    rationale: '只调用年龄值域、占位号、纯数字姓名等封闭形状函数。',
  },
  {
    id: 'collection_dialogue_confirmation',
    authority: 'notary',
    effect: 'reject',
    source: 'src/resolution/notary/dialogue-confirmation.ts#isAssistantQuestionConfirmedInDialogue',
    rationale: '只核验真实相邻问答、求证语气与封闭肯定短答。',
  },
  {
    id: 'booking_candidate_name_provenance',
    authority: 'notary',
    effect: 'reject',
    source: 'src/resolution/candidate/identity-attribution.ts#evaluateBookingNameGate',
    rationale: '只核验结构化姓名出处、引用 speaker 标记与已公证事实；拒收后有确认出口。',
  },
  {
    id: 'booking_candidate_phone_provenance',
    authority: 'notary',
    effect: 'reject',
    source: 'src/resolution/candidate/identity-attribution.ts#evaluateBookingPhoneGate',
    rationale: '手机号形状与候选人自陈文本逐字出处双重核验。',
  },
  {
    id: 'job_list_job_id_provenance',
    authority: 'structural_gate',
    effect: 'reject',
    source: 'src/tools/duliday-job-list.tool.ts#context.archive.isRecalledJobId',
    rationale: 'jobId 必须属于会话召回、本轮查询或在途工单构成的结构化集合。',
  },
  {
    id: 'precheck_job_id_provenance',
    authority: 'structural_gate',
    effect: 'reject',
    source: 'src/tools/duliday-interview-precheck.tool.ts#context.archive.isRecalledJobId',
    rationale: 'precheck 的 jobId 只做结构化出处集合成员判定。',
  },
  {
    id: 'booking_job_id_provenance',
    authority: 'structural_gate',
    effect: 'reject',
    source: 'src/tools/duliday-interview-booking.tool.ts#context.archive.isRecalledJobId',
    rationale: 'booking defense-in-depth 复用同一 jobId 出处集合，不理解自然语言。',
  },
  {
    id: 'precheck_required_field_difference',
    authority: 'structural_gate',
    effect: 'mark_missing',
    source: 'src/tools/duliday-interview-precheck.tool.ts#buildChecklistTemplate',
    rationale: '判缺是必填字段集合减去 accepted / needs_confirmation 账本字段的集合运算。',
  },
  {
    id: 'candidate_rule_fact_prompt_hint',
    authority: 'hint',
    effect: 'advisory',
    source: 'src/agent/generator/context/sections/working/turn-hints.section.ts#renderCurrentHints',
    rationale: '规则识别只进模型内部提示便签，模型与候选人保留决定权。',
  },
  {
    id: 'candidate_profile_prefill_hint',
    authority: 'hint',
    effect: 'advisory',
    source: 'src/agent/generator/preparation/tool-context.builder.ts#buildCandidatePrefillHints',
    rationale: 'medium/system 值只投影为带值求证，不得据此拒绝、提交或升级来源。',
  },
] as const satisfies readonly VerdictSiteRegistration[];
