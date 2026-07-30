import { Injectable, Logger } from '@nestjs/common';
import type { InputRiskType } from '@shared-types/guardrail.contract';
import type { TurnSideEffectIntent } from '@agent/runner/turn-side-effect.types';

interface InputRiskDetectionResult {
  hit: boolean;
  riskType?: InputRiskType;
  riskLabel?: string;
  summary?: string;
  reason?: string;
}

const ABUSE_KEYWORDS = [
  '傻逼',
  '傻x',
  '煞笔',
  '脑残',
  // 不收 '有病'：候选人常说"家里有病人 / 我爸有病要照顾"等真实诉求，substring
  // 匹配会误伤为辱骂。要骂人通常会用 '神经病 / 傻逼 / sb / 操你' 等明确词。
  '神经病',
  '垃圾',
  '废物',
  '滚',
  '去死',
  '王八蛋',
  '妈的',
  '操你',
  '他妈',
  'sb',
  'cnm',
] as const;

const COMPLAINT_RISK_KEYWORDS = [
  '投诉',
  '举报',
  '曝光',
  '劳动局',
  '仲裁',
  '骗人',
  '骗子',
  '坑',
  '报警',
  '维权',
  '欺骗',
  '黑心',
] as const;

/**
 * 历史面试结果追问关键词。
 * 候选人询问"为什么没通过/上次面试结果"时，Agent 无法获取面试结果信息，
 * 继续推岗会显得漠视候选人关切，产品要求立即转人工。
 */
const INTERVIEW_RESULT_INQUIRY_KEYWORDS = [
  '为什么没通过',
  '为什么没过面试',
  '面试没通过',
  '面试失败了',
  '上次面试结果',
  '面试结果怎么样',
  '没收到面试结果',
] as const;

/**
 * 候选人主动要求转人工的高置信短语。
 *
 * 业务背景（badcase 6a5df7e7ce406a6aee043595，2026-07-20）：候选人礼貌发"转人工"后
 * 无任何确定性响应（词表只有辱骂/投诉/面试结果三类），3 分钟静默后升级为辱骂才命中
 * abuse 拦截——系统实际教会候选人"骂人才能叫来真人"。
 *
 * 处置与 abuse 同款：确定性静默 + 暂停托管 + 飞书告警，出站零话术——人设是真人招募
 * 经理，接管发生在同一企微账号上，任何"帮你转人工/叫真人"话术反而是唯一暴露 AI 身份
 * 的环节（[[feedback_no_bot_identity_leak_in_handoff]]）。
 *
 * 误伤防护："转人工/转接人工"字面几乎零歧义，任意位置命中即判；其余短语（找人工/
 * 人工客服/叫人工/要人工）只在**短消息**（剥表情占位与标点后 ≤ 8 字）中判定——
 * "人工客服岗位还招人吗"这类岗位咨询必须放行。
 */
const HUMAN_HANDOFF_EXACT_KEYWORDS = ['转人工', '转接人工'] as const;
const HUMAN_HANDOFF_SHORT_KEYWORDS = ['找人工', '人工客服', '叫人工', '要人工'] as const;
const HUMAN_HANDOFF_SHORT_MESSAGE_MAX_LENGTH = 8;

/**
 * 残障身份主动披露（产品+运营裁定 2026-07-28，badcase gkaszeip/zmuhev8o 簇：
 * 聋哑候选人被约到拒收门店辗转两店当面被拒）：候选人主动披露残障身份或询问残障者
 * 能否应聘时，确定性静默转人工，由真人判断如何沟通处理；Agent 不得输出任何自动
 * 话术——"委婉拒绝"属残障就业歧视（《残疾人保障法》），绝不自动化，也不建
 * 岗位侧筛选字段。
 *
 * 边界（防误伤 + 防画像）：
 * - 只认**明确自述**与**资格询问**两种形态；严禁任何推断式识别（打字习惯、
 *   表达方式、语音使用等一律不算）。
 * - 自述式要求"我/本人"与"是/有"紧邻，天然排除"我爸是残疾人要照顾"等家属
 *   描述——家属情况不是候选人本人身份，不触发。
 */
const DISABILITY_TERM =
  '(?:聋哑|听障|听力障碍|视障|视力障碍|言语障碍|语言障碍|肢体残疾|残疾|残障|哑巴)';
const DISABILITY_DISCLOSURE_PATTERNS: readonly RegExp[] = [
  // 明确自述：我是聋哑人 / 我有残疾证 / 本人属于听障
  new RegExp(`(?:我|本人)(?:是|有|也是|就是|属于)[的个]?${DISABILITY_TERM}`),
  /(?:我|本人)(?:听不见|听不到|耳朵听不(?:见|到|清))/,
  /我的?残疾证/,
  // 资格询问（问者自涉）：聋哑人能做吗 / 残疾人要不要 / 收不收听障
  new RegExp(
    `${DISABILITY_TERM}(?:人|人士)?[^，。！？!?\\n]{0,6}(?:能|可以|行不行|要不要|收不收|招不招)`,
  ),
  // 疑问句式（动词后置）：残疾人招吗 / 精神残疾招的？/ 听障收不 —— badcase 2026-07-29
  // chat 6a69c1ed…：「残疾人招吗」「精神残疾招的？」两问均未命中上一档（其动词表只有
  // 能/可以/要不要/收不收/招不招），Agent 直答"招的"并继续推岗，是本档唯一的暴露口。
  new RegExp(
    `${DISABILITY_TERM}(?:人|人士)?[^，。！？!?\\n]{0,6}(?:招|收|要)(?:的|得)?(?:吗|嘛|么|不|\\?|？)`,
  ),
  new RegExp(`(?:招|收|要)(?:不(?:招|收|要))?[^，。！？!?\\n]{0,4}${DISABILITY_TERM}`),
];
/** 表情占位（[强]/[微笑]…）与标点，短消息长度判定前剥除。 */
const EMOJI_PLACEHOLDER_RE = /\[[^\]]{1,8}\]/g;
const PUNCTUATION_RE = /[\s，。！？!?~～、.…；;：:"'“”‘’()（）]/gu;

export interface PreAgentRiskPrecheckResult {
  hit: boolean;
  riskType?: InputRiskType;
  reason?: string;
  label?: string;
}

export interface RiskInterceptEvaluation extends PreAgentRiskPrecheckResult {
  sideEffect?: TurnSideEffectIntent;
}

/** 渠道无关的预检入参。Agent 回合入口负责构造纯文本 scanContent 与身份字段。 */
export interface RiskInterceptInput {
  corpId: string;
  chatId: string;
  userId: string;
  pauseTargetId: string;
  /** 已抽取/拼接好的待扫描文本（已过滤图片/表情占位）。 */
  scanContent: string;
  messageId?: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
}

/**
 * Pre-Agent 同步风险预检（input guardrail）。
 *
 * 职责：在 Agent 推理之前，只基于本轮用户输入的高置信关键词规则判断是否需要
 * 确定性拦截。命中时产出 conversation_risk side-effect intent，由被采纳的 outcome
 * 统一出口执行。
 *
 * 本服务自身做 detect→decide；**是否短路** Agent 由 AgentRunner.runTurn 按 `hit`
 * 统一收口成 guardrail_blocked/inbound outcome。当前 WeCom 入站命中即
 * 「确定性静默 + 转人工」，本轮不再跑 Agent 也不发安抚回复（旧版「不短路、仍发安抚话术」的
 * 设计会与投递前 isAnyPaused 检查竞态、回复大概率被丢弃，行为不确定，已废弃）。
 * 分层：detect（本服务内部关键词检测）→ **decide（本守卫）** → outcome sideEffects →
 * act（统一出口暂停/告警）。
 * 本守卫只吃中立 `RiskInterceptInput`，不依赖任何渠道 DTO/parser，也不读取会话历史
 * 或 session state；需要语义理解/上下文升级的风险交给 raise_risk_alert 工具闭环处理。
 */
@Injectable()
export class RiskInterceptService {
  private readonly logger = new Logger(RiskInterceptService.name);

  async evaluate(input: RiskInterceptInput): Promise<RiskInterceptEvaluation> {
    const content = input.scanContent?.trim() ?? '';
    if (!input.chatId || !input.userId || !content) {
      return { hit: false };
    }

    const detection = this.detectHighConfidenceRisk(content);
    if (!detection.hit) {
      return { hit: false };
    }

    this.logger.warn(
      `[PreAgentRiskPrecheck] 命中规则: chatId=${input.chatId}, type=${detection.riskType}, reason=${detection.reason}`,
    );

    return {
      hit: true,
      riskType: detection.riskType,
      reason: detection.reason,
      label: detection.riskLabel,
      sideEffect: {
        kind: 'conversation_risk',
        source: 'regex_intercept',
        riskType: detection.riskType ?? 'abuse',
        riskLabel: detection.riskLabel ?? '交流异常',
        summary: detection.summary ?? '候选人消息命中高置信度风险关键词',
        reason: detection.reason ?? '命中规则',
        currentMessageContent: content,
      },
    };
  }

  /** 兼容旧调用方的方法名：只返回判定与 side-effect intent，不执行副作用。 */
  async precheck(input: RiskInterceptInput): Promise<PreAgentRiskPrecheckResult> {
    const evaluation = await this.evaluate(input);
    if (!evaluation.hit) {
      return { hit: false };
    }
    return {
      hit: true,
      riskType: evaluation.riskType,
      reason: evaluation.reason,
      label: evaluation.label,
    };
  }

  private detectHighConfidenceRisk(content: string): InputRiskDetectionResult {
    const abuseResult = this.detectKeywordRisk(
      content,
      ABUSE_KEYWORDS,
      'abuse',
      '辱骂/攻击',
      '候选人出现明显辱骂或攻击性表达',
    );
    if (abuseResult.hit) {
      return abuseResult;
    }

    const complaintResult = this.detectKeywordRisk(
      content,
      COMPLAINT_RISK_KEYWORDS,
      'complaint_risk',
      '投诉/举报风险',
      '候选人出现明确投诉、举报或欺骗风险表达',
    );
    if (complaintResult.hit) {
      return complaintResult;
    }

    const interviewResult = this.detectKeywordRisk(
      content,
      INTERVIEW_RESULT_INQUIRY_KEYWORDS,
      'interview_result_inquiry',
      '历史面试结果追问',
      '候选人询问历史面试结果，Agent 无权限获取该信息，需立即转人工处理',
    );
    if (interviewResult.hit) {
      return interviewResult;
    }

    const humanHandoffResult = this.detectHumanHandoffRequest(content);
    if (humanHandoffResult.hit) {
      return humanHandoffResult;
    }

    const disabilityResult = this.detectDisabilityDisclosure(content);
    if (disabilityResult.hit) {
      return disabilityResult;
    }

    return { hit: false };
  }

  /** 残障身份主动披露：见 DISABILITY_* 常量注释（只认明确自述/资格询问，禁推断）。 */
  private detectDisabilityDisclosure(content: string): InputRiskDetectionResult {
    const normalized = this.normalize(content);
    const matched = DISABILITY_DISCLOSURE_PATTERNS.find((pattern) => pattern.test(normalized));
    if (!matched) {
      return { hit: false };
    }

    return {
      hit: true,
      riskType: 'disability_disclosure',
      riskLabel: '候选人披露残障身份',
      summary:
        '候选人主动披露残障身份或询问残障者能否应聘，已静默暂停托管。合规敏感（残障就业受法律保护）：' +
        '请真人尽快用同一账号自然接续，按岗位实际情况人工判断与沟通；不要使用任何模板式拒绝话术，' +
        '不要提及 AI、机器人或转接。',
      reason: `命中残障身份披露模式：${matched.source}`,
    };
  }

  /** 候选人主动要求转人工：见 HUMAN_HANDOFF_* 常量注释（词表边界 + 短消息防误伤）。 */
  private detectHumanHandoffRequest(content: string): InputRiskDetectionResult {
    const normalized = this.normalize(content);
    const matched: string[] = [];

    for (const keyword of HUMAN_HANDOFF_EXACT_KEYWORDS) {
      if (normalized.includes(keyword)) matched.push(keyword);
    }

    if (matched.length === 0) {
      const compact = normalized.replace(EMOJI_PLACEHOLDER_RE, '').replace(PUNCTUATION_RE, '');
      if (compact.length <= HUMAN_HANDOFF_SHORT_MESSAGE_MAX_LENGTH) {
        for (const keyword of HUMAN_HANDOFF_SHORT_KEYWORDS) {
          if (compact.includes(keyword)) matched.push(keyword);
        }
      }
    }

    if (matched.length === 0) {
      return { hit: false };
    }

    return {
      hit: true,
      riskType: 'human_handoff_request',
      riskLabel: '候选人主动要求人工',
      summary:
        '候选人明确要求转人工，已静默暂停托管。候选人正在等待，请尽快用同一账号自然接续' +
        '（首句如"刚在忙，你说"），不要提及 AI、机器人或转接。',
      reason: `命中转人工请求关键词：${matched.join('、')}`,
    };
  }

  private detectKeywordRisk(
    content: string,
    keywords: readonly string[],
    riskType: InputRiskType,
    riskLabel: string,
    summary: string,
  ): InputRiskDetectionResult {
    const matchedKeywords = this.findMatchedKeywords(content, keywords);
    if (matchedKeywords.length === 0) {
      return { hit: false };
    }

    return {
      hit: true,
      riskType,
      riskLabel,
      summary,
      reason: `命中关键词：${matchedKeywords.join('、')}`,
    };
  }

  private findMatchedKeywords(content: string, keywords: readonly string[]): string[] {
    const normalized = this.normalize(content);
    return keywords.filter((keyword) => {
      const normalizedKeyword = this.normalize(keyword);
      if (normalizedKeyword === '滚') {
        return this.matchesAbusiveGun(normalized);
      }
      if (normalizedKeyword === '坑') {
        return this.matchesScamKeng(normalized);
      }
      return normalized.includes(normalizedKeyword);
    });
  }

  private normalize(content: string): string {
    return content.trim().toLowerCase();
  }

  private matchesAbusiveGun(content: string): boolean {
    const compact = content.replace(/\s+/g, '');
    if (!compact) {
      return false;
    }

    // "滚" 是高风险单字，也容易出现在"好运滚滚来/滚动"等无害表达中。
    const punctuation = '[!！?？。.,，、~～]*';
    if (new RegExp(`^滚${punctuation}$`).test(compact)) {
      return true;
    }

    const abusiveSuffixes = [
      '出去',
      '远一点',
      '一边去',
      '犊子',
      '回去',
      '开',
      '蛋',
      '出',
      '远点',
      '吧',
      '啊',
      '呀',
      '啦',
      '呢',
      '你',
      '尼玛',
      'nmd',
      'nm',
      '妈',
    ];
    const suffixPattern = `(?:${abusiveSuffixes.join('|')}|[!！?？。.,，、~～]|$)`;

    if (new RegExp(`(?:^|[!！?？。.,，、~～])滚${suffixPattern}`).test(compact)) {
      return true;
    }

    const imperativePrefixes = [
      '你',
      '你们',
      '妳',
      '您',
      '他',
      '她',
      '它',
      '给我',
      '让你',
      '让你们',
      '让他',
      '让她',
      '让它',
      '叫你',
      '叫你们',
      '叫他',
      '叫她',
      '叫它',
      '快',
      '快点',
      '赶紧',
      '马上',
      '都',
    ];
    return new RegExp(`(?:${imperativePrefixes.join('|')})滚${suffixPattern}`).test(compact);
  }

  private matchesScamKeng(content: string): boolean {
    const compact = content.replace(/\s+/g, '');
    if (!compact) {
      return false;
    }

    // "坑" 只在"坑人/坑钱/太坑"等诈骗投诉语义中命中，避免误伤坑梓等地名。
    const punctuation = '[!！?？。.,，、~～]*';
    if (new RegExp(`^坑${punctuation}$`).test(compact)) {
      return true;
    }

    const scamPrefixes = ['太', '真', '好', '很', '超', '忒', '巨', '老', '够', '被', '净', '专'];
    if (new RegExp(`(?:${scamPrefixes.join('|')})坑`).test(compact)) {
      return true;
    }

    const scamSuffixes = [
      '人',
      '钱',
      '爹',
      '货',
      '骗',
      '客',
      '客户',
      '顾客',
      '消费者',
      '老百姓',
      '学生',
      '我',
      '我们',
      '你',
      '你们',
      '死',
      '惨',
    ];
    return new RegExp(`坑(?:${scamSuffixes.join('|')})`).test(compact);
  }
}
