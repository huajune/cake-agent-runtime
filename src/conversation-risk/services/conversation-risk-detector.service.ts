import { Injectable } from '@nestjs/common';
import {
  ABUSE_KEYWORDS,
  COMPLAINT_RISK_KEYWORDS,
  ESCALATION_KEYWORDS,
  SOFT_NEGATIVE_KEYWORDS,
} from '../rules/conversation-risk.rules';
import {
  ConversationRiskContext,
  ConversationRiskDetectionResult,
  ConversationRiskMessage,
  ConversationRiskReviewSignal,
} from '../types/conversation-risk.types';

@Injectable()
export class ConversationRiskDetectorService {
  detect(context: ConversationRiskContext): ConversationRiskDetectionResult {
    const abuseResult = this.detectKeywordRisk(
      context,
      ABUSE_KEYWORDS,
      'abuse',
      '辱骂/攻击',
      '候选人出现明显辱骂或攻击性表达',
    );
    if (abuseResult.hit) {
      return abuseResult;
    }

    const complaintResult = this.detectKeywordRisk(
      context,
      COMPLAINT_RISK_KEYWORDS,
      'complaint_risk',
      '投诉/举报风险',
      '候选人出现明确投诉、举报或欺骗风险表达',
    );
    if (complaintResult.hit) {
      return complaintResult;
    }

    return { hit: false };
  }

  buildLlmReviewSignal(context: ConversationRiskContext): ConversationRiskReviewSignal | null {
    const escalationSignal = this.detectEscalationSignal(context);
    if (escalationSignal) {
      return escalationSignal;
    }

    const softNegativeSignal = this.detectSoftNegativeSignal(context);
    if (softNegativeSignal) {
      return softNegativeSignal;
    }

    return null;
  }

  private detectKeywordRisk(
    context: ConversationRiskContext,
    keywords: readonly string[],
    riskType: ConversationRiskDetectionResult['riskType'],
    riskLabel: string,
    summary: string,
  ): ConversationRiskDetectionResult {
    const evidenceMessages = this.getCurrentTurnUserMessages(context).filter(
      (message) => this.findMatchedKeywords(message.content, keywords).length > 0,
    );

    if (evidenceMessages.length === 0) {
      return { hit: false };
    }

    const matchedKeywords = Array.from(
      new Set(
        evidenceMessages.flatMap((message) => this.findMatchedKeywords(message.content, keywords)),
      ),
    );

    return {
      hit: true,
      riskType,
      riskLabel,
      summary,
      reason: `命中关键词：${matchedKeywords.join('、')}`,
      matchedKeywords,
      evidenceMessages: evidenceMessages.slice(-3),
      analysisMode: 'rules',
    };
  }

  private getCurrentTurnUserMessages(context: ConversationRiskContext): ConversationRiskMessage[] {
    const currentTurnMessages: ConversationRiskMessage[] = [];

    for (let index = context.recentMessages.length - 1; index >= 0; index--) {
      const message = context.recentMessages[index];
      if (message.role !== 'user') {
        break;
      }
      currentTurnMessages.push(message);
    }

    if (currentTurnMessages.length > 0) {
      return currentTurnMessages.reverse();
    }

    const currentContent = context.currentMessageContent.trim();
    if (!currentContent) {
      return [];
    }

    return [
      {
        role: 'user',
        content: currentContent,
        timestamp: context.recentMessages.at(-1)?.timestamp ?? 0,
      },
    ];
  }

  private detectEscalationSignal(
    context: ConversationRiskContext,
  ): ConversationRiskReviewSignal | null {
    const recentUserMessages = context.recentMessages.filter((message) => message.role === 'user');
    const tailUserMessages = recentUserMessages.slice(-3);
    const matchedMessages = tailUserMessages.filter((message) => this.isEscalationMessage(message));

    if (tailUserMessages.length < 2 || matchedMessages.length < 2) {
      return null;
    }

    const matchedKeywords = Array.from(
      new Set(
        matchedMessages.flatMap((message) =>
          this.findMatchedKeywords(message.content, ESCALATION_KEYWORDS),
        ),
      ),
    );

    return {
      suggestedRiskType: 'escalation',
      summary: '候选人近期连续追问，情绪有明显升级趋势',
      reason:
        matchedKeywords.length > 0
          ? `连续追问表达：${matchedKeywords.join('、')}`
          : '最近多条用户消息存在连续追问或催促表达',
      matchedKeywords,
      evidenceMessages: matchedMessages,
    };
  }

  private detectSoftNegativeSignal(
    context: ConversationRiskContext,
  ): ConversationRiskReviewSignal | null {
    const recentUserMessages = context.recentMessages.filter((message) => message.role === 'user');
    const evidenceMessages = recentUserMessages
      .slice(-3)
      .filter(
        (message) => this.findMatchedKeywords(message.content, SOFT_NEGATIVE_KEYWORDS).length > 0,
      );

    if (evidenceMessages.length === 0) {
      return null;
    }

    const matchedKeywords = Array.from(
      new Set(
        evidenceMessages.flatMap((message) =>
          this.findMatchedKeywords(message.content, SOFT_NEGATIVE_KEYWORDS),
        ),
      ),
    );

    return {
      suggestedRiskType: 'escalation',
      summary: '候选人出现明显负面情绪，需要结合上下文做复判',
      reason: `软负向表达：${matchedKeywords.join('、')}`,
      matchedKeywords,
      evidenceMessages,
    };
  }

  private isEscalationMessage(message: ConversationRiskMessage): boolean {
    if (message.role !== 'user') {
      return false;
    }

    const content = this.normalize(message.content);
    if (!content) {
      return false;
    }

    return (
      this.findMatchedKeywords(content, ESCALATION_KEYWORDS).length > 0 ||
      /[?？!！]{2,}/.test(content) ||
      /^(在吗|人呢|为什么|怎么|到底)/.test(content)
    );
  }

  private findMatchedKeywords(content: string, keywords: readonly string[]): string[] {
    const normalized = this.normalize(content);
    return keywords.filter((keyword) => {
      const normalizedKeyword = this.normalize(keyword);
      if (normalizedKeyword === '滚') {
        return this.matchesAbusiveGun(normalized);
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

    // "滚" is a high-risk single-character keyword, but it also appears in benign
    // phrases like "好运滚滚来" or words like "滚动". Only treat it as abuse when
    // it is standalone or attached to common imperative/insult suffixes.
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
}
