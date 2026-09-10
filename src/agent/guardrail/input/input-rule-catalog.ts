import { INPUT_RISK_TYPE, type InputRiskType } from '@shared-types/guardrail.contract';
import type { GuardrailCatalogEntry } from '../catalog.types';

export type PromptInjectionCategory = 'role_hijack' | 'prompt_leak' | 'system_marker';

interface PromptInjectionRule extends GuardrailCatalogEntry {
  category: PromptInjectionCategory;
  label: string;
  pattern: RegExp;
}

const PROMPT_INJECTION_CATEGORIES = {
  role_hijack: {
    label: '角色劫持',
    riskGoal: '识别要求忽略既有指令或切换为无限制角色的输入，提供防护提示与安全告警。',
  },
  prompt_leak: {
    label: '提示词泄露',
    riskGoal: '识别索取系统提示或内部指令的输入，提供防护提示与安全告警。',
  },
  system_marker: {
    label: '指令注入',
    riskGoal: '识别伪造系统消息边界的输入，提供防护提示与安全告警。',
  },
} as const;

function definePromptInjectionRule<Id extends string>(
  id: Id,
  category: PromptInjectionCategory,
  pattern: RegExp,
  description: string,
) {
  return {
    id,
    layer: 'input',
    stage: 'input_pre_agent',
    action: 'observe',
    coverage: 'hybrid',
    priority: 'P0',
    category,
    pattern,
    ...PROMPT_INJECTION_CATEGORIES[category],
    description,
    source: 'agent/guardrail/input/prompt-injection-detector.ts',
    entrypoint: 'PromptInjectionDetector.detect',
    exogenousSignal: '本批候选人输入原文与本条确定性正则匹配；只读本批输入，不回扫历史窗口。',
    residualRisk:
      '仅识别封闭词形，改写、编码和跨消息注入可能漏检；命中只观测告警并追加防护提示，不阻断或修改消息。',
    verification:
      'tests/agent/guardrail/input/input-rule-catalog.spec.ts + tests/agent/guardrail/input/prompt-injection-detector.spec.ts + tests/agent/guardrail/input/prompt-security-observer.service.spec.ts',
    owner: 'agent-input',
    status: 'active',
  } as const satisfies PromptInjectionRule;
}

/** 检测器直接执行本表；显式 ID 保证插入新模式不会重编号既有告警。顺序即首命中顺序。 */
export const PROMPT_INJECTION_RULES = [
  definePromptInjectionRule(
    'role_hijack_1',
    'role_hijack',
    /ignore\s+(all\s+)?previous\s+instructions/i,
    '观测要求忽略先前指令的英文输入。',
  ),
  definePromptInjectionRule(
    'role_hijack_2',
    'role_hijack',
    /ignore\s+(all\s+)?above/i,
    '观测要求忽略上文的英文输入。',
  ),
  definePromptInjectionRule(
    'role_hijack_3',
    'role_hijack',
    /disregard\s+(all\s+)?previous/i,
    '观测要求不理会先前内容的英文输入。',
  ),
  definePromptInjectionRule(
    'role_hijack_4',
    'role_hijack',
    /forget\s+(all\s+)?(your\s+)?instructions/i,
    '观测要求遗忘既有指令的英文输入。',
  ),
  definePromptInjectionRule(
    'role_hijack_5',
    'role_hijack',
    /你现在是(?:一个|一名|位)?(?:黑客|DAN|开发者模式|无限制|无约束|没有限制|不受限制|无需遵守|无视规则)/i,
    '观测“你现在是”紧接黑客、DAN 或无限制身份的角色改写。',
  ),
  definePromptInjectionRule(
    'role_hijack_6',
    'role_hijack',
    /(?:从现在起你(?:的角色|是)|假装你是|扮演一个)[^，。！？!?\n]{0,24}(?:黑客|DAN|开发者模式|无限制|没有限制|无约束|不受限制|无视规则|系统管理员)/i,
    '观测在限定字距内要求扮演黑客、无限制角色或系统管理员的输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_1',
    'prompt_leak',
    /repeat\s+(your\s+)?system\s+prompt/i,
    '观测要求复述系统提示的英文输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_2',
    'prompt_leak',
    /show\s+(me\s+)?(your\s+)?instructions/i,
    '观测要求展示内部指令的英文输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_3',
    'prompt_leak',
    /what\s+are\s+your\s+(system\s+)?instructions/i,
    '观测询问内部或系统指令内容的英文输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_4',
    'prompt_leak',
    /print\s+(your\s+)?prompt/i,
    '观测要求打印提示词的英文输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_5',
    'prompt_leak',
    /输出(你的)?系统提示/,
    '观测要求输出系统提示的中文输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_6',
    'prompt_leak',
    /打印(你的)?指令/,
    '观测要求打印内部指令的中文输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_7',
    'prompt_leak',
    /显示(你的)?系统(消息|提示词|指令)/,
    '观测要求显示系统消息、提示词或指令的中文输入。',
  ),
  definePromptInjectionRule(
    'prompt_leak_8',
    'prompt_leak',
    /把(你的)?提示词(告诉我|给我|发出来)/,
    '观测要求告知或发送提示词的中文输入。',
  ),
  definePromptInjectionRule(
    'system_marker_1',
    'system_marker',
    /\[\[SYSTEM\]\]/i,
    '观测伪造的双方括号 SYSTEM 消息标记。',
  ),
  definePromptInjectionRule(
    'system_marker_2',
    'system_marker',
    /<\|im_start\|>system/i,
    '观测伪造的 im_start 系统角色边界。',
  ),
  definePromptInjectionRule(
    'system_marker_3',
    'system_marker',
    /<\|system\|>/i,
    '观测伪造的 system 特殊 token。',
  ),
  definePromptInjectionRule(
    'system_marker_4',
    'system_marker',
    /\[INST\]/i,
    '观测伪造的 INST 指令边界。',
  ),
  definePromptInjectionRule(
    'system_marker_5',
    'system_marker',
    /###\s*System/i,
    '观测伪造的 Markdown System 标题。',
  ),
  definePromptInjectionRule(
    'system_marker_6',
    'system_marker',
    /```system/i,
    '观测伪造的 system 代码围栏。',
  ),
] as const;

export interface InputRiskRule<Risk extends InputRiskType = InputRiskType>
  extends GuardrailCatalogEntry {
  id: Risk;
  riskType: Risk;
  riskLabel: string;
  summary: string;
}

function defineInputRiskRule<Risk extends InputRiskType>(
  riskType: Risk,
  details: Pick<
    InputRiskRule,
    'riskLabel' | 'summary' | 'description' | 'exogenousSignal' | 'residualRisk' | 'entrypoint'
  >,
) {
  return {
    id: riskType,
    riskType,
    layer: 'input',
    stage: 'input_pre_agent',
    action: 'handoff',
    coverage: 'code',
    priority: 'P0',
    riskGoal: '高置信风险输入命中时静默短路 Agent，并产出暂停托管与人工接管告警意图。',
    source: 'agent/guardrail/input/risk-intercept.service.ts',
    verification:
      'tests/agent/guardrail/input/input-rule-catalog.spec.ts + tests/agent/guardrail/input/risk-intercept.service.spec.ts',
    owner: 'agent-input',
    status: 'active',
    ...details,
  } as const satisfies InputRiskRule<Risk>;
}

/** 风险分类、告警文案和处置元数据唯一居所；匹配词表与边界仍归 RiskInterceptService。 */
export const INPUT_RISK_RULES = {
  [INPUT_RISK_TYPE.ABUSE]: defineInputRiskRule(INPUT_RISK_TYPE.ABUSE, {
    riskLabel: '辱骂/攻击',
    summary: '候选人出现明显辱骂或攻击性表达',
    description: '候选人辱骂词或封闭攻击句式命中后静默暂停托管；保留“滚”语境及亲属称呼例外。',
    entrypoint: 'RiskInterceptService.detectKeywordRisk + RiskInterceptService.detectPatternRisk',
    exogenousSignal: '剥除引用块后的本轮候选人原话；明确辱骂词或面向“你/你们”的垃圾攻击句式。',
    residualRisk: '规则不理解反讽或变体；未列举攻击表达可能漏检，候选人自己引用脏话也可能命中。',
  }),
  [INPUT_RISK_TYPE.COMPLAINT_RISK]: defineInputRiskRule(INPUT_RISK_TYPE.COMPLAINT_RISK, {
    riskLabel: '投诉/举报风险',
    summary: '候选人出现明确投诉、举报或欺骗风险表达',
    description: '候选人投诉、举报或欺骗风险词，以及封闭曝光、报警、仲裁动作句式触发静默人工接管。',
    entrypoint: 'RiskInterceptService.detectKeywordRisk + RiskInterceptService.detectPatternRisk',
    exogenousSignal: '剥除引用块后的本轮候选人原话；投诉词表或带明确动作意向的封闭句式。',
    residualRisk: '不读取历史或推断投诉语义；未列举表达可能漏检，关键词的无关自述可能误伤。',
  }),
  [INPUT_RISK_TYPE.INTERVIEW_RESULT_INQUIRY]: defineInputRiskRule(
    INPUT_RISK_TYPE.INTERVIEW_RESULT_INQUIRY,
    {
      riskLabel: '历史面试结果追问',
      summary: '候选人询问历史面试结果，Agent 无权限获取该信息，需立即转人工处理',
      description: '候选人追问历史面试结果或未通过原因时静默转人工，避免继续推岗忽略当前关切。',
      entrypoint: 'RiskInterceptService.detectKeywordRisk',
      exogenousSignal: '剥除引用块后的本轮候选人原话与历史面试结果追问词表匹配。',
      residualRisk: '限定词表不覆盖所有追问改写；实际面试结果仍由人工查询与解释。',
    },
  ),
  [INPUT_RISK_TYPE.HUMAN_HANDOFF_REQUEST]: defineInputRiskRule(
    INPUT_RISK_TYPE.HUMAN_HANDOFF_REQUEST,
    {
      riskLabel: '候选人主动要求人工',
      summary:
        '候选人明确要求转人工，已静默暂停托管。候选人正在等待，请尽快用同一账号自然接续' +
        '（首句如"刚在忙，你说"），不要提及 AI、机器人或转接。',
      description:
        '明确转人工短语或去除表情标点后不超过 8 字的人工请求，触发静默接管且不输出转接话术。',
      entrypoint: 'RiskInterceptService.detectHumanHandoffRequest',
      exogenousSignal: '剥除引用块后的本轮候选人原话；明确转人工词或短消息中的高置信人工请求词。',
      residualRisk:
        '长消息中的“找人工/人工客服”等词按防误伤策略放行；其他委婉人工请求需主 Agent 判断。',
    },
  ),
  [INPUT_RISK_TYPE.DISABILITY_DISCLOSURE]: defineInputRiskRule(
    INPUT_RISK_TYPE.DISABILITY_DISCLOSURE,
    {
      riskLabel: '候选人披露残障身份',
      summary:
        '候选人主动披露残障身份或询问残障者能否应聘，已静默暂停托管。合规敏感（残障就业受法律保护）：' +
        '请真人尽快用同一账号自然接续，按岗位实际情况人工判断与沟通；不要使用任何模板式拒绝话术，' +
        '不要提及 AI、机器人或转接。',
      description: '明确残障身份自述或资格询问命中后静默转人工，禁止自动拒绝、筛选或推断身份。',
      entrypoint: 'RiskInterceptService.detectDisabilityDisclosure',
      exogenousSignal:
        '剥除引用块后的本轮候选人明确自述或自涉资格询问；亲属/他人词阻断扩展自述模式。',
      residualRisk:
        '只覆盖封闭自述与资格询问形态，未列举表达可能漏检；实际沟通与判断依赖人工接续。',
    },
  ),
} as const satisfies { [Risk in InputRiskType]: InputRiskRule<Risk> };

/** 非整数风险键的插入顺序就是原有优先级；检测器与审计目录共享此序列。 */
export const INPUT_RISK_RULE_ORDER = Object.values(INPUT_RISK_RULES);

export const INPUT_GUARDRAIL_CATALOG: readonly GuardrailCatalogEntry[] = [
  ...PROMPT_INJECTION_RULES,
  ...INPUT_RISK_RULE_ORDER,
];
