/**
 * 信号检测器 — 纯规则检测（needs + riskFlags）
 *
 * 职责：
 * - 检测用户消息中的事实需求（needs）— 关键词正则匹配
 * - 检测对话中的风险信号（riskFlags）— 关键词正则匹配
 * - 格式化检测结果为 prompt 片段 — 追加到 systemPrompt 末尾
 *
 * 设计原则：
 * - 零 LLM 调用，零延迟，零成本
 * - 阶段策略格式化由 StageStrategySection 负责（配置驱动）
 * - 本服务只做消息驱动的动态检测
 * - riskFlags 作为安全网，确保合规风险不被遗漏
 */

import { Injectable, Logger } from '@nestjs/common';

// ==================== 分类器自有类型 ====================

/** 回复需求 — 分类器识别用户消息中隐含的信息查询意图 */
export const REPLY_NEEDS = [
  'stores',
  'location',
  'salary',
  'schedule',
  'policy',
  'availability',
  'requirements',
  'interview',
  'none',
] as const;

export type ReplyNeed = (typeof REPLY_NEEDS)[number];

/** 需求检测规则 — 关键词 → 需求映射 */
interface NeedRule {
  need: ReplyNeed;
  patterns: RegExp[];
}

/** 风险标记 — 分类器识别对话中的合规风险信号 */
export const RISK_FLAGS = ['age_sensitive', 'insurance_promise_risk'] as const;

export type RiskFlag = (typeof RISK_FLAGS)[number];

/** 风险检测规则 — 关键词 → 风险映射 */
interface RiskRule {
  flag: RiskFlag;
  patterns: RegExp[];
}

const RISK_RULES: RiskRule[] = [
  {
    flag: 'age_sensitive',
    patterns: [/\d{1,2}岁|未成年|初中|高中|在校|学生|中学|小学|没毕业/i],
  },
  {
    flag: 'insurance_promise_risk',
    patterns: [/五险一金|社保|保险|公积金|医保|养老|工伤/i],
  },
];

const NEED_RULES: NeedRule[] = [
  { need: 'salary', patterns: [/薪资|工资|时薪|底薪|提成|奖金|补贴|多少钱|收入/i] },
  { need: 'schedule', patterns: [/排班|班次|几点|上班|下班|工时|周末|节假日|做几天/i] },
  { need: 'policy', patterns: [/五险一金|社保|保险|合同|考勤|迟到|补班|试用期/i] },
  { need: 'availability', patterns: [/还有名额|空位|可用时段|什么时候能上|明天能面/i] },
  { need: 'location', patterns: [/在哪|位置|地址|附近|地铁|门店|哪个区|多远/i] },
  { need: 'stores', patterns: [/门店|哪家店|哪些店|有店吗/i] },
  { need: 'requirements', patterns: [/要求|条件|年龄|经验|学历|健康证|身高|体重/i] },
  { need: 'interview', patterns: [/面试|到店|约时间|约面/i] },
];

// ==================== 检测结果 ====================

export interface DetectionResult {
  needs: ReplyNeed[];
  riskFlags: RiskFlag[];
}

// ==================== 服务 ====================

@Injectable()
export class SignalDetectorService {
  private readonly logger = new Logger(SignalDetectorService.name);

  /**
   * 检测用户消息中的需求和风险信号
   *
   * 一次扫描同时输出 needs + riskFlags，避免重复提取消息文本。
   */
  detect(messages: { role: string; content: string }[]): DetectionResult {
    const { lastMessage, conversationHistory } = this.extractConversation(messages);
    const text = `${conversationHistory.slice(-4).join(' ')} ${lastMessage}`;

    const needs = this.matchNeeds(text);
    const riskFlags = this.matchRiskFlags(text);

    if (needs.length > 0 || riskFlags.length > 0) {
      this.logger.debug(
        `检测结果: needs=[${needs.join(', ')}] riskFlags=[${riskFlags.join(', ')}]`,
      );
    }

    return { needs, riskFlags };
  }

  /**
   * 格式化检测结果为 prompt 片段
   *
   * 追加到 systemPrompt 末尾，告知模型本轮触发了哪些需求和风险。
   */
  formatDetectionBlock(result: DetectionResult): string {
    const lines: string[] = [];

    const needsDisplay = result.needs.filter((n) => n !== 'none');
    if (needsDisplay.length > 0) {
      lines.push(`[检测到的需求]: ${needsDisplay.join(', ')}`);
    }

    if (result.riskFlags.length > 0) {
      lines.push(`[风险提醒]: ${result.riskFlags.join(', ')}`);
    }

    return lines.join('\n');
  }

  // ==================== 私有方法 ====================

  private matchNeeds(text: string): ReplyNeed[] {
    const needs = new Set<ReplyNeed>();

    for (const rule of NEED_RULES) {
      if (rule.patterns.some((p) => p.test(text))) {
        needs.add(rule.need);
      }
    }

    if (needs.size === 0) needs.add('none');
    else needs.delete('none');

    return Array.from(needs);
  }

  private matchRiskFlags(text: string): RiskFlag[] {
    const flags = new Set<RiskFlag>();

    for (const rule of RISK_RULES) {
      if (rule.patterns.some((p) => p.test(text))) {
        flags.add(rule.flag);
      }
    }

    return Array.from(flags);
  }

  /** 从消息列表提取对话文本 */
  private extractConversation(messages: { role: string; content: string }[]): {
    lastMessage: string;
    conversationHistory: string[];
  } {
    const lines = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? '用户' : '招募经理'}: ${m.content}`)
      .filter((s) => s.trim().length > 0);

    return {
      lastMessage: lines.at(-1) ?? '',
      conversationHistory: lines.slice(0, -1),
    };
  }
}
