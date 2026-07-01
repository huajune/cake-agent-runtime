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

    return { hit: false };
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
