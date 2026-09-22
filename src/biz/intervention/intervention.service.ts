import { Injectable, Logger, Optional } from '@nestjs/common';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { InterventionTaskService } from '@notification/feishu-task/intervention-task.service';
import { ConversationRiskNotifierService } from '@notification/services/conversation-risk-notifier.service';
import { GeneralHandoffNotifierService } from '@notification/services/general-handoff-notifier.service';
import type { WeworkSessionState } from '@memory/short-term/short-term.types';
import { requiresManualResumeForReason } from '@enums/handoff-reason.enum';

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
  riskType:
    | 'abuse'
    | 'complaint_risk'
    | 'escalation'
    | 'interview_result_inquiry'
    | 'human_handoff_request'
    | 'disability_disclosure';
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

/**
 * 面试之后的环节一律真人对接（2026-09-16 运营裁定，生产 chat 6a9f7db6ce406a6aee13b137）。
 * 面试后类转人工不能在次日零点自动解禁——事故里托管隔天自动恢复，Agent 接回后指引候选人到店白干；
 * 改为暂停到人工在 Dashboard 恢复为止。其余转人工仍按默认次日零点解禁。
 * 哪些码永久暂停由权威目录（@enums/handoff-reason.enum 的 manualResumeOnly）决定，不在此重复维护。
 */
export function requiresManualResume(payload: InterventionPayload): boolean {
  if (payload.kind === 'conversation_risk') {
    return requiresManualResumeForReason(payload.riskType);
  }
  return requiresManualResumeForReason(payload.reasonCode);
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

    const manualResume = requiresManualResume(payload);
    await this.userHostingService.pauseUser(payload.pauseTargetId, {
      source: 'intervention',
      permanent: manualResume,
      reason: manualResume
        ? '面试后人工对接，需人工恢复托管'
        : payload.kind === 'conversation_risk'
          ? '会话风险人工介入'
          : '人工介入暂停',
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

    // 飞书任务（PRD R6）：异步、不阻塞群卡片与暂停；失败由任务服务自行告警。
    this.submitFeishuTask(payload);

    return {
      dispatched: true,
      paused: true,
      alerted,
      suppressed: alerted ? undefined : 'notify_failed',
      reason: payload.reason,
    };
  }

  private submitFeishuTask(payload: InterventionPayload): void {
    if (!this.interventionTaskService) return;
    void this.interventionTaskService.submit(payload).catch((error: unknown) => {
      this.logger.warn(
        `[Intervention] 飞书任务提交异常（已忽略）: chatId=${payload.chatId} error=${toErrorMessage(error)}`,
      );
    });
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
    });
  }
}
