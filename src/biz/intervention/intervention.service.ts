import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import type { ActionCompletion } from '@biz/action-execution/action-execution.types';
import {
  ACTION_EVIDENCE_KIND,
  ACTION_KIND,
  ACTION_MODE,
  ACTION_STATE,
  LOCAL_SYNC_STATE,
} from '@shared-types/action-execution.contract';
import { FeishuSendError } from '@infra/feishu/services/webhook.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { InterventionTaskService } from '@notification/feishu-task/intervention-task.service';
import { ConversationRiskNotifierService } from '@notification/services/conversation-risk-notifier.service';
import { GeneralHandoffNotifierService } from '@notification/services/general-handoff-notifier.service';
import type { WeworkSessionState } from '@memory/short-term/short-term.types';
import type { ConversationRiskType } from '@shared-types/guardrail.contract';

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
  riskType: ConversationRiskType;
  riskLabel: string;
  summary: string;
  reason: string;
  source: 'regex_intercept' | 'agent_tool';
}

/**
 * 人工介入（handoff）。不区分 onboard/general，
 * 统一为暂停托管 + 飞书告警。
 */
export interface GeneralHandoffInterventionPayload extends InterventionBase {
  kind: 'general_handoff';
  alertLabel: string;
  /** 转人工原因代码（request_handoff 枚举）；卡片按它分时效等级。 */
  reasonCode?: string;
  reason: string;
  actionAdvice?: string;
  /** 关联工单 ID（来自 active_booking），透传到告警卡片。 */
  workOrderId?: number | null;
  /** 岗位数据缺口（salary_admin_inquiry）：卡片展示给运营补录。 */
  missingJobInfo?: string[];
  source: 'agent_tool' | 'output_guardrail';
}

export type InterventionPayload = RiskInterventionPayload | GeneralHandoffInterventionPayload;

export interface ReplyHandoffIdentity {
  logicalTurnId: string;
  accountId: string;
  occurredAt: string;
  key: string;
}

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
 * 输出：执行「暂停托管 + 飞书告警」的原子组合（不更新任何业务状态机）
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
    @Optional() private readonly interventionTaskService?: InterventionTaskService,
    @Optional() private readonly actions?: ActionExecutorService,
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

    // 转人工统一进入临时禁止托管，次日零点恢复；面试后业务仍由真人处理。
    await this.userHostingService.pauseUser(payload.pauseTargetId, {
      source: 'intervention',
      handoffScope: { corpId: payload.corpId, botImId: payload.botImId, chatId: payload.chatId },
      permanent: false,
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

    // 暂停与通知先完成；返回前等待飞书任务被持久化到恢复队列。
    await this.submitFeishuTask(payload);

    return {
      dispatched: true,
      paused: true,
      alerted,
      suppressed: alerted ? undefined : 'notify_failed',
      reason: payload.reason,
    };
  }

  private async submitFeishuTask(payload: InterventionPayload): Promise<void> {
    if (!this.interventionTaskService) return;
    try {
      await this.interventionTaskService.submit(payload);
    } catch (error) {
      // Safety pause has already succeeded; queue failure must not undo it or repeat the alert.
      this.logger.error(
        `[Intervention] 飞书任务未持久化: chatId=${payload.chatId} error=${toErrorMessage(error)}`,
      );
    }
  }

  /** The ticket records demand for a handoff. Only the webhook receipt confirms its dispatch. */
  async dispatchRecorded(
    payload: InterventionPayload,
    identity: ReplyHandoffIdentity,
  ): Promise<InterventionResult> {
    if (!this.actions || !this.interventionTaskService || !payload.pauseTargetId)
      throw new Error('handoff_dispatch_unavailable');
    const action = await this.actions.execute<{ taskToken: string }>(
      {
        corpId: payload.corpId,
        accountId: identity.accountId,
        chatId: payload.chatId,
        logicalTurnId: identity.logicalTurnId,
        occurredAt: identity.occurredAt,
        intentId: identity.key,
        target: `handoff:${payload.chatId}:${identity.key}`,
        kind: ACTION_KIND.HANDOFF_NOTIFICATION,
        parameters: { kind: payload.kind, reason: payload.reason },
        identityReliable: true,
      },
      { dispatch: () => this.sendRecordedNotification(payload) },
      { persistedMode: ACTION_MODE.EXECUTE },
    );
    if (
      action.status !== ACTION_STATE.SUCCEEDED ||
      action.localSync !== LOCAL_SYNC_STATE.COMPLETE ||
      !action.result?.taskToken
    )
      throw new Error('handoff_notification_unconfirmed');
    await this.interventionTaskService.submit(payload, action.result.taskToken);
    return { dispatched: true, paused: true, alerted: true, reason: payload.reason };
  }

  private async sendRecordedNotification(
    payload: InterventionPayload,
  ): Promise<ActionCompletion<{ taskToken: string }>> {
    let notificationStarted = false;
    try {
      const paused = await this.userHostingService.confirmHandoffPause(payload.pauseTargetId, {
        source: 'intervention',
        permanent: false,
        handoffScope: { corpId: payload.corpId, botImId: payload.botImId, chatId: payload.chatId },
        reason: payload.kind === 'conversation_risk' ? '会话风险人工介入' : '人工介入暂停',
      });
      if (!paused) throw new Error('handoff_pause_unconfirmed');
      notificationStarted = true;
      const accepted =
        payload.kind === 'conversation_risk'
          ? await this.notifyRisk(payload, true)
          : await this.notifyGeneralHandoff(payload, true);
      if (!accepted) throw new Error('handoff_notification_unconfirmed');
      return {
        status: ACTION_STATE.SUCCEEDED,
        result: { taskToken: randomUUID() },
        evidence: {
          kind: ACTION_EVIDENCE_KIND.ACCEPTED,
          requestTerminated: true,
          detail: 'handoff_webhook_accepted',
        },
      };
    } catch (error) {
      if (
        !notificationStarted ||
        (error instanceof FeishuSendError && error.rejectedBeforeAcceptance)
      )
        return {
          status: ACTION_STATE.FAILED,
          retryable: true,
          evidence: {
            kind: ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT,
            requestTerminated: true,
            detail: 'handoff_notification_not_accepted',
          },
        };
      return {
        status: ACTION_STATE.UNKNOWN,
        evidence: {
          kind: ACTION_EVIDENCE_KIND.INDETERMINATE,
          requestTerminated: false,
          detail: 'handoff_webhook_result_unknown',
        },
      };
    }
  }

  private notifyRisk(payload: RiskInterventionPayload, singleAttempt = false): Promise<boolean> {
    const card = {
      corpId: payload.corpId,
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
    };
    return singleAttempt
      ? this.riskNotifier.notifyConversationRisk(card, true)
      : this.riskNotifier.notifyConversationRisk(card);
  }

  private notifyGeneralHandoff(
    payload: GeneralHandoffInterventionPayload,
    singleAttempt = false,
  ): Promise<boolean> {
    const card = {
      alertLabel: payload.alertLabel,
      reasonCode: payload.reasonCode,
      reason: payload.reason,
      actionAdvice: payload.actionAdvice,
      workOrderId: payload.workOrderId,
      missingJobInfo: payload.missingJobInfo,
      corpId: payload.corpId,
      botImId: payload.botImId,
      botUserName: payload.botUserName,
      contactName: payload.contactName,
      chatId: payload.chatId,
      pausedUserId: payload.pauseTargetId,
      currentMessageContent: payload.currentMessageContent,
      recentMessages: payload.recentMessages,
      sessionState: payload.sessionState,
    };
    return singleAttempt
      ? this.generalHandoffNotifier.notify(card, true)
      : this.generalHandoffNotifier.notify(card);
  }
}
