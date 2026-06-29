import { Injectable, Logger } from '@nestjs/common';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SessionService } from '@memory/services/session.service';
import { InterventionService } from '@biz/intervention/intervention.service';
import { ConversationRiskDetectorService } from '@/conversation-risk/services/conversation-risk-detector.service';
import type { ConversationRiskContext } from '@/conversation-risk/types/conversation-risk.types';

export interface PreAgentRiskPrecheckResult {
  hit: boolean;
  riskType?: string;
  reason?: string;
  label?: string;
}

/**
 * 渠道无关的预检入参。渠道侧（reply-workflow）负责把入站 DTO 解析成纯文本扫描内容
 * （`scanContent`，已过滤视觉占位）与身份字段后传入——这样本守卫不依赖任何渠道 DTO/parser，
 * 物理归位到 agent/guardrail/input/，不形成 agent→channels 反向依赖。
 */
export interface RiskInterceptInput {
  corpId: string;
  chatId: string;
  userId: string;
  pauseTargetId: string;
  /** 已抽取/拼接好的待扫描文本（渠道侧已过滤图片/表情占位）。 */
  scanContent: string;
  messageId?: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
}

/**
 * Pre-Agent 同步风险预检（input guardrail）。
 *
 * 职责：在 Agent 推理之前，用高置信度关键词规则（ConversationRiskDetector，外生信号源）
 * 判断候选人最近消息是否存在明显辱骂/投诉/举报。命中即异步触发人工介入副作用
 * （fire-and-forget）：暂停托管 + 飞书告警，并向调用方返回 `{ hit: true }`。
 *
 * 本服务自身只做 detect→decide→act 的副作用 dispatch，不直接终止流程；**是否短路** Agent
 * 由调用渠道按 `hit` 决定。当前 WeCom 入站（reply-workflow）命中即「确定性静默 + 转人工」、
 * 本轮不再跑 Agent 也不发安抚回复（旧版「不短路、仍发安抚话术」的设计会与投递前 isAnyPaused
 * 检查竞态、回复大概率被丢弃，行为不确定，已废弃）。Agent 推理中亦可经 `raise_risk_alert`
 * 工具触发同样副作用。
 *
 * 分层：detect（conversation-risk 信号）→ **decide（本守卫）** → act（intervention 暂停/告警）。
 * 渠道 DTO 解析留在渠道侧（依赖倒置），本守卫只吃中立 `RiskInterceptInput`。
 */
@Injectable()
export class RiskInterceptService {
  private readonly logger = new Logger(RiskInterceptService.name);

  constructor(
    private readonly detector: ConversationRiskDetectorService,
    private readonly interventionService: InterventionService,
    private readonly chatSessionService: ChatSessionService,
    private readonly sessionService: SessionService,
  ) {}

  async precheck(input: RiskInterceptInput): Promise<PreAgentRiskPrecheckResult> {
    const content = input.scanContent?.trim() ?? '';
    if (!input.chatId || !input.userId || !content) {
      return { hit: false };
    }

    const [recentMessages, sessionState] = await Promise.all([
      this.chatSessionService.getChatHistory(input.chatId, 10).catch(() => []),
      this.sessionService
        .getSessionState(input.corpId, input.userId, input.chatId)
        .catch(() => null),
    ]);

    const context: ConversationRiskContext = {
      corpId: input.corpId,
      chatId: input.chatId,
      userId: input.userId,
      pauseTargetId: input.pauseTargetId,
      messageId: input.messageId,
      contactName: input.contactName,
      botImId: input.botImId,
      botUserName: input.botUserName,
      currentMessageContent: content,
      recentMessages: recentMessages
        .filter((m) => !this.isVisualGeneratedContent(m.content))
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          timestamp: m.timestamp,
        })),
      sessionState,
    };

    const detection = this.detector.detect(context);
    if (!detection.hit) {
      return { hit: false };
    }

    this.logger.warn(
      `[PreAgentRiskPrecheck] 命中规则: chatId=${input.chatId}, type=${detection.riskType}, reason=${detection.reason}`,
    );

    void this.interventionService
      .dispatch({
        kind: 'conversation_risk',
        source: 'regex_intercept',
        riskType: detection.riskType ?? 'abuse',
        riskLabel: detection.riskLabel ?? '交流异常',
        summary: detection.summary ?? '候选人消息命中高置信度风险关键词',
        reason: detection.reason ?? '命中规则',
        chatId: input.chatId,
        corpId: input.corpId,
        userId: input.userId,
        pauseTargetId: input.pauseTargetId,
        botImId: input.botImId,
        botUserName: input.botUserName,
        contactName: input.contactName,
        currentMessageContent: content,
        recentMessages: context.recentMessages,
        sessionState,
      })
      .catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[PreAgentRiskPrecheck] intervention dispatch failed: chatId=${input.chatId}, reason=${errorMessage}`,
        );
      });

    return {
      hit: true,
      riskType: detection.riskType,
      reason: detection.reason,
      label: detection.riskLabel,
    };
  }

  /** chat 历史里视觉生成内容（图片/表情描述）不参与风险关键词扫描。 */
  private isVisualGeneratedContent(content: string | undefined): boolean {
    return /^\s*\[(?:图片|表情)消息\]/.test(content ?? '');
  }
}
