import { Injectable, Logger } from '@nestjs/common';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { ConversationRiskNotifierService } from '@notification/services/conversation-risk-notifier.service';
import { OnboardFollowupNotifierService } from '@notification/services/onboard-followup-notifier.service';
import type { WeworkSessionState } from '@memory/types/session-facts.types';
import type { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';

export interface InterventionMessageSnapshot {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface InterventionBase {
  chatId: string;
  corpId: string;
  userId: string;
  pauseTargetId: string;
  botImId?: string;
  botUserName?: string;
  contactName?: string;
  currentMessageContent: string;
  recentMessages: InterventionMessageSnapshot[];
  sessionState: WeworkSessionState | null;
}

export interface RiskInterventionPayload extends InterventionBase {
  kind: 'conversation_risk';
  riskType: 'abuse' | 'complaint_risk' | 'escalation';
  riskLabel: string;
  summary: string;
  reason: string;
  source: 'regex_intercept' | 'agent_tool';
}

export interface HandoffInterventionPayload extends InterventionBase {
  kind: 'onboard_handoff';
  caseId: string;
  alertLabel: string;
  reason: string;
  summary?: string;
  recruitmentCase: RecruitmentCaseRecord;
  source: 'agent_tool';
}

export type InterventionPayload = RiskInterventionPayload | HandoffInterventionPayload;

export interface InterventionResult {
  dispatched: boolean;
  paused: boolean;
  alerted: boolean;
  suppressed?: 'already_paused' | 'missing_target' | 'notify_failed';
  reason?: string;
}

/**
 * 统一的人工介入编排服务。
 *
 * 输入：调用方（规则层 / Agent tool）已完成判断的介入事件
 * 输出：执行「暂停托管 + 更新业务状态 + 飞书告警」的原子组合
 *
 * 本服务不包含任何判断逻辑，也不决定安抚话术。
 */
@Injectable()
export class InterventionService {
  private readonly logger = new Logger(InterventionService.name);

  constructor(
    private readonly userHostingService: UserHostingService,
    private readonly recruitmentCaseService: RecruitmentCaseService,
    private readonly riskNotifier: ConversationRiskNotifierService,
    private readonly handoffNotifier: OnboardFollowupNotifierService,
  ) {}

  async dispatch(payload: InterventionPayload): Promise<InterventionResult> {
    if (!payload.pauseTargetId) {
      return { dispatched: false, paused: false, alerted: false, suppressed: 'missing_target' };
    }

    const alreadyPaused = await this.userHostingService.isUserPaused(payload.pauseTargetId);
    if (alreadyPaused) {
      return {
        dispatched: false,
        paused: false,
        alerted: false,
        suppressed: 'already_paused',
      };
    }

    await this.userHostingService.pauseUser(payload.pauseTargetId);

    const alerted =
      payload.kind === 'conversation_risk'
        ? await this.notifyRisk(payload)
        : await this.notifyHandoff(payload);

    if (payload.kind === 'onboard_handoff') {
      await this.recruitmentCaseService.markHandoff(payload.caseId);
    }

    this.logger.warn(
      `[Intervention] kind=${payload.kind} source=${payload.source} chatId=${payload.chatId} alerted=${alerted}`,
    );

    return {
      dispatched: true,
      paused: true,
      alerted,
      suppressed: alerted ? undefined : 'notify_failed',
      reason: payload.reason,
    };
  }

  private notifyRisk(payload: RiskInterventionPayload): Promise<boolean> {
    return this.riskNotifier.notifyConversationRisk({
      riskLabel: payload.riskLabel,
      summary: payload.summary,
      reason: payload.reason,
      botImId: payload.botImId,
      botUserName: payload.botUserName,
      contactName: payload.contactName,
      chatId: payload.chatId,
      pausedUserId: payload.pauseTargetId,
      currentMessageContent: payload.currentMessageContent,
      recentMessages: payload.recentMessages,
      sessionState: payload.sessionState,
    });
  }

  private notifyHandoff(payload: HandoffInterventionPayload): Promise<boolean> {
    return this.handoffNotifier.notify({
      alertLabel: payload.alertLabel,
      reason: payload.reason,
      botImId: payload.botImId,
      botUserName: payload.botUserName,
      contactName: payload.contactName,
      chatId: payload.chatId,
      pausedUserId: payload.pauseTargetId,
      currentMessageContent: payload.currentMessageContent,
      recentMessages: payload.recentMessages,
      sessionState: payload.sessionState,
      recruitmentCase: payload.recruitmentCase,
    });
  }
}
