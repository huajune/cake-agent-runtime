import { Injectable, Logger } from '@nestjs/common';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { ConversationRiskNotifierService } from '@notification/services/conversation-risk-notifier.service';
import { GeneralHandoffNotifierService } from '@notification/services/general-handoff-notifier.service';
import type { WeworkSessionState } from '@memory/types/session-facts.types';

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
  riskType: 'abuse' | 'complaint_risk' | 'escalation' | 'interview_result_inquiry';
  riskLabel: string;
  summary: string;
  reason: string;
  source: 'regex_intercept' | 'agent_tool';
}

/**
 * 人工介入（handoff）。recruitment_cases 已废弃后 handoff 不再区分 onboard/general，
 * 统一为暂停托管 + 飞书告警。
 */
export interface GeneralHandoffInterventionPayload extends InterventionBase {
  kind: 'general_handoff';
  alertLabel: string;
  reason: string;
  actionAdvice?: string;
  source: 'agent_tool';
}

export type InterventionPayload = RiskInterventionPayload | GeneralHandoffInterventionPayload;

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
    private readonly riskNotifier: ConversationRiskNotifierService,
    private readonly generalHandoffNotifier: GeneralHandoffNotifierService,
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

    await this.userHostingService.pauseUser(payload.pauseTargetId, {
      source: 'intervention',
      reason: payload.kind === 'conversation_risk' ? '会话风险人工介入' : '人工介入暂停',
    });

    // handoff 运行时状态只用 pause 一层（recruitment_cases 状态机已废弃，不再 markHandoff）。
    // 触发分析价值沉到 handoff_events + ops_events.handoff.triggered。

    let alerted = false;
    if (payload.kind === 'conversation_risk') {
      alerted = await this.notifyRisk(payload);
    } else {
      alerted = await this.notifyGeneralHandoff(payload);
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

  private notifyGeneralHandoff(payload: GeneralHandoffInterventionPayload): Promise<boolean> {
    return this.generalHandoffNotifier.notify({
      alertLabel: payload.alertLabel,
      reason: payload.reason,
      actionAdvice: payload.actionAdvice,
      corpId: payload.corpId,
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
}
