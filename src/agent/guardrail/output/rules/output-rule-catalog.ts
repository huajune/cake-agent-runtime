import {
  GUARDRAIL_ACTION,
  GUARDRAIL_DATA_SENSITIVITY,
  GUARDRAIL_FEEDBACK_POLICY,
  GUARDRAIL_PRIORITY,
  type GuardrailPriority,
} from '@shared-types/guardrail.contract';
import {
  deriveRulePolicy,
  type GuardrailRuleAction,
  type OutputRulePolicy,
} from '../output-rule.types';

/**
 * 登记当前实际运行的封闭确定性规则：执行档（revise/block）+ 少量 observe 哨兵。
 * observe 哨兵只落档不改变出站裁决；新规则一律 observe
 * 入场，升档须 ≥2 周判例且精确率 ≥90%。
 */
export interface OutputRuleCatalogMetadata extends OutputRulePolicy {
  id: string;
  action: GuardrailRuleAction;
  priority: GuardrailPriority;
  description: string;
  riskGoal: string;
  exogenousSignal: string;
  residualRisk: string;
  verification: string;
  repairToolNames: readonly string[];
}

type OutputRuleCatalogSeed = Omit<OutputRuleCatalogMetadata, keyof OutputRulePolicy | 'action'> &
  Partial<OutputRulePolicy> & { action: GuardrailRuleAction };

function applyPolicy(rule: OutputRuleCatalogSeed): OutputRuleCatalogMetadata {
  const derived = deriveRulePolicy(rule.action);
  return {
    ...derived,
    severity: rule.severity ?? rule.priority,
    dataSensitivity: rule.dataSensitivity ?? GUARDRAIL_DATA_SENSITIVITY.NONE,
    feedbackPolicy:
      rule.feedbackPolicy ??
      (derived.currentReplySendable
        ? GUARDRAIL_FEEDBACK_POLICY.NONE
        : GUARDRAIL_FEEDBACK_POLICY.PLAIN_POLICY),
    feedbackToGenerator:
      rule.feedbackToGenerator ??
      (derived.currentReplySendable
        ? ''
        : '上一版回复命中封闭确定性规则。只删除或修正违规部分，保留工具已确认事实，只输出候选人可见回复。'),
    repairToolNames: [],
    ...rule,
  };
}

const V = 'tests/agent/guardrail/output/hard-rules.service.spec.ts';

const OUTPUT_RULE_CATALOG_SEEDS = [
  {
    id: 'invalid_model_output',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '模型输出含推理标签或整条仅为长数字标识符。',
    riskGoal: '阻止异常 completion 被当作候选人回复发送。',
    exogenousSignal: '<think> 标签或纯数字输出形态。',
    residualRisk: '不对一般语言质量做语义判断。',
    verification: V,
  },
  {
    id: 'internal_output_leak',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '内部阶段、工具、JSON 或代码围栏泄漏。',
    riskGoal: '避免内部实现暴露给候选人。',
    exogenousSignal: '封闭内部标记和格式。',
    residualRisk: '未登记的自然语言隐喻不在规则能力内。',
    verification: V,
  },
  {
    id: 'meta_narration_reply',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '整条回复是括号包裹的 Agent 自我旁白。',
    riskGoal: '防止静默意图或内心独白外发。',
    exogenousSignal: '整条括号形态与封闭元叙述词。',
    residualRisk: '正文混排的开放式旁白交给主 Agent。',
    verification: V,
  },
  {
    id: 'identity_misregistration_coaching',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '教唆以不实学生/暑假工身份登记或隐瞒身份。',
    riskGoal: '阻止身份造假指导。',
    exogenousSignal: '封闭造假教唆句式与已确认身份/预检事实。',
    residualRisk: '不猜测候选人真实身份。',
    verification: V,
  },
  {
    id: 'experience_fraud_coaching',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '候选人自曝经历造假后，教其继续声称有相关经历。',
    riskGoal: '阻止经历造假指导。',
    exogenousSignal: '候选人造假自曝与封闭教唆句式。',
    residualRisk: '不判断经历真假，只处理已自曝场景。',
    verification: V,
  },
  {
    id: 'discriminatory_screening_leak',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '对外泄漏或用敏感属性拒绝候选人。',
    riskGoal: '防止形成歧视性筛选聊天证据。',
    exogenousSignal: '封闭拒收/限招句式与敏感属性。',
    residualRisk: '性别、年龄等业务公开条件不在本规则内。',
    verification: V,
    dataSensitivity: GUARDRAIL_DATA_SENSITIVITY.HIGH,
    feedbackPolicy: GUARDRAIL_FEEDBACK_POLICY.REDACTED,
  },
  {
    id: 'sensitive_origin_probe',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '主动打听籍贯、老家或是否本地人。',
    riskGoal: '防止反向索取敏感出身属性。',
    exogenousSignal: '封闭籍贯疑问句。',
    residualRisk: '常驻城市和工作地点询问不在本规则内。',
    verification: V,
    dataSensitivity: GUARDRAIL_DATA_SENSITIVITY.HIGH,
    feedbackPolicy: GUARDRAIL_FEEDBACK_POLICY.REDACTED,
  },
  {
    id: 'quota_promise',
    action: GUARDRAIL_ACTION.BLOCK,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '承诺名额不会满或已经替候选人保留。',
    riskGoal: '阻止无工具可兑现的名额保证。',
    exogenousSignal: '封闭名额保证句式。',
    residualRisk: '明确说明无法保留或状态会变化时放行。',
    verification: V,
  },
  {
    id: 'online_interview_location_claim',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '线上面试回执却引导候选人到店面试。',
    riskGoal: '避免候选人因面试形式错配白跑。',
    exogenousSignal: '预检/预约结构化面试形式与到店话术。',
    residualRisk: '不推断缺少结构化形式的面试。',
    verification: V,
  },
  {
    id: 'unsupported_store_status_speculation',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '明确无匹配工具事实被扩写为招满、关店、搬迁或装修。',
    riskGoal: '防止把无匹配查询结果升级成门店运营结论。',
    exogenousSignal: 'duliday_job_list 明确 noMatchScript 与运营状态断言。',
    residualRisk: '没有明确 no-match 工具事实时不运行。',
    verification: V,
  },
  {
    id: 'booking_receipt_mismatch',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '预约成功/失败、日期与群用途等结构化回执不一致。',
    riskGoal: '确保不可逆预约动作与候选人收到的回执一致。',
    exogenousSignal: 'booking 工具结构化回执。',
    residualRisk: '不比较没有结构化回执的开放语义。',
    verification: V,
  },
  {
    id: 'interview_time_change_unconfirmed',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '未成功改约却确认了与在途工单不同的钟点。',
    riskGoal: '避免候选人按未落单时间到店。',
    exogenousSignal: 'duplicateBookingGuard 与 modify 工具回执。',
    residualRisk: '模糊相对时间不做确定性推断。',
    verification: V,
  },
  {
    id: 'brand_alias_fuzzy_match_ignored',
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '工具已高置信回指品牌，回复仍声称该品牌未找到。',
    riskGoal: '让品牌目录高置信回执得到一致使用。',
    exogenousSignal: 'duliday_job_list.queryMeta.brand.fuzzySuggestions。',
    residualRisk: '低置信或多候选不强行采用。',
    verification: V,
  },
  // ——以下为 数据复核恢复的规则（规则简化改造的定点回补，非整体回滚）——
  {
    id: 'human_service_phrase_leak',
    // observe 入场；升 revise：两周 5 判例全真阳性零误报。
    // 恢复：简化改造误删后，近 7 天生产仍有 2 例真阳人设露馅直发前被拦，
    // 封闭词形符合"只保留封闭词形"的保留标准。
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P2,
    description: '打回重写出现"转人工/人工客服/真人经理/专人联系"等与账号本人人设冲突表述的回复。',
    riskGoal: '防止"转人工/真人/专人"类客服话术自曝机器人身份，破坏"账号即本人"人设。',
    exogenousSignal: '人设露馅封闭词库（转人工/人工客服/人工登记/真人经理/专人联系等）。',
    residualRisk:
      '隐性人机暗示（"系统显示"、"机器人"自嘲等）不在封闭词表内，需随判例补词；' +
      '重写只修正人设露馅措辞，不推断承诺是否具备外部动作支撑。',
    verification: 'tests/agent/guardrail/output/hard-rules.restored-sentinels.spec.ts',
    feedbackToGenerator:
      '上一版回复出现"转人工/人工客服/真人经理/专人联系"类表述，与"候选人看到的这个账号就是你本人"的身份设定冲突，当前文本不可发送。' +
      '只把露馅措辞改成人设内口径（如"我帮你问下同事""让负责的同事联系你"），其余内容原样保留，不要改变承诺的事实和后续动作。',
  },
  {
    id: 'booking_done_claim_without_submission',
    // 新哨兵：接替已删 booking_promise_without_booking 的完成时态缺口（将来时口径
    // 经生产抽样证实几乎全命中合法收资话术，不恢复）。按发牌纪律 observe 入场，
    // 已知残余风险=跨轮合法提醒会命中，须先累计判例再议升档。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '零 booking 调用却用完成时态宣称"已帮你报好/报名成功"。',
    riskGoal: '发现报名从未提交却被宣称已办好的假回执，防候选人空等。',
    exogenousSignal: '本轮 booking/modify 工具调用存在性与 precheck duplicateBookingGuard。',
    residualRisk: '跨轮合法提醒（前几轮已真实建单）会命中，observe 期以判例分辨占比。',
    verification: 'tests/agent/guardrail/output/rules/booking-claim-reconciliation.rule.spec.ts',
  },
  {
    id: 'cancel_done_claim_without_submission',
    // 与 booking_done_claim_without_submission 同族同风险：跨轮合法提醒会命中，observe 入场。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '零 cancel/modify 调用却用完成时态宣称"面试已取消/已改期"。',
    riskGoal: '发现取消从未提交却被宣称已办好的假回执，防候选人据此不到店。',
    exogenousSignal: '本轮 duliday_cancel_work_order / duliday_modify_interview_time 调用存在性。',
    residualRisk: '跨轮合法提醒（前几轮已真实取消）会命中，observe 期以判例分辨占比。',
    verification: 'tests/agent/guardrail/output/rules/booking-claim-reconciliation.rule.spec.ts',
    feedbackToGenerator:
      '上一版回复宣称面试已取消/已改期，但本轮没有任何取消或改期工具调用。若确实已办好请复述工单事实，' +
      '否则改成如实说明当前状态并说明下一步动作，不要用完成时态宣称未发生的操作。',
  },
  {
    id: 'cancel_done_claim_failed_tool',
    // 硬矛盾：本轮工具自证失败，不存在跨轮复述的解释空间，故直接 revise。
    action: GUARDRAIL_ACTION.REVISE,
    priority: GUARDRAIL_PRIORITY.P0,
    description: '本轮取消/改期工具全部失败，回复却宣称已取消/已改期。',
    riskGoal: '防候选人据假回执不到店而爽约（代价与到店扑空同级）。',
    exogenousSignal: '本轮取消/改期工具调用的 status 全为 error。',
    residualRisk: '无——本轮工具失败是自证事实，不依赖跨轮推断。',
    verification: 'tests/agent/guardrail/output/rules/booking-claim-reconciliation.rule.spec.ts',
    feedbackToGenerator:
      '上一版回复宣称面试已取消/已改期，但本轮取消/改期工具全部调用失败，该操作并未发生。' +
      '必须如实告知候选人当前预约仍然有效、正在安排人工跟进处理，不得保留任何"已取消/已改好"的表述。',
  },
  {
    id: 'dangling_reply_promise',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '观察首版回复只给将来时查询承诺（"我帮你查下X"）、没有任何结果性内容的样本。',
    riskGoal: '候选人收到承诺后再无下文会一直空等——量化首版悬空规模，供升档决策。',
    exogenousSignal:
      '复用 runner 的 isDanglingCheckReply 纯谓词（短文本+将来时承诺+无结果性标记）。',
    residualRisk:
      '刻意不升 REVISE：改写只会把承诺改成"暂时没岗位"的编造，根治在生成侧；' +
      '退场条件：累计两周精确率 <70% 则删除。',
    verification: 'tests/agent/guardrail/output/rules/dangling-promise.rule.spec.ts',
  },
  {
    id: 'requested_brand_mismatch',
    // 降 observe：结构化标题解析可能把门店名当品牌名，确定性修复易改坏正确回复。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '候选人/工具已指定品牌，回复却结构化推荐了其它品牌的岗位。',
    riskGoal: '候选人指定品牌时不得静默跨品牌推荐，须先说明未找到并征得接受。',
    exogenousSignal: 'duliday_job_list.queryMeta.brand 实际应用品牌与回复结构化推荐品牌。',
    residualRisk: '候选人已明确接受替代品牌的跨轮上下文暂未纳入；门店名误判为品牌仍可能假阳。',
    verification: 'tests/agent/guardrail/output/rules/brand-name-errors.rule.spec.ts',
  },
  {
    id: 'settlement_cycle_mismatch',
    // 否定语序和补充结算语境会制造假阳，保持 observe；重新满足准入门槛才能申请动手权。
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '本轮岗位工具已返回结算口径时，标记把培训/阶梯月补说成整份工资月结的回复。',
    riskGoal: '结算方式直接影响候选人决策，正式工资与补充费用的结算范围必须分别表述。',
    exogenousSignal: '本轮 duliday_job_list 返回的 salaryPeriod 与回复中的结算断言。',
    residualRisk: '句子已把周期限定在阶梯/差价/培训范围内即豁免；非标准结算别名需随样本扩充。',
    verification: 'tests/agent/guardrail/output/rules/settlement-renderer-contract.spec.ts',
  },
  {
    id: 'proactive_insurance_policy_mention',
    action: GUARDRAIL_ACTION.OBSERVE,
    priority: GUARDRAIL_PRIORITY.P1,
    description: '候选人没问保险时，主动给出保险、社保、五险等承诺式口径。',
    riskGoal: '观察准不可逆承诺样本，供运营复盘是否需要收窄成可执行契约。',
    exogenousSignal: '候选人本轮 userMessage 与近几轮消息（recentUserTexts）是否主动询问保险。',
    residualRisk: '任职要求豁免（第二职业社保证明等资格预筛）会放行岗位硬性要求转述。',
    verification: 'tests/agent/guardrail/output/hard-rules.restored-sentinels.spec.ts',
  },
] as const satisfies readonly OutputRuleCatalogSeed[];

export const OUTPUT_RULE_CATALOG = OUTPUT_RULE_CATALOG_SEEDS.map(applyPolicy);
export const OUTPUT_RULE_IDS = OUTPUT_RULE_CATALOG.map((rule) => rule.id);
