import { Injectable, Logger } from '@nestjs/common';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import { SessionService } from '@memory/services/session.service';
import { FollowUpSchedulerService } from './follow-up-scheduler.service';
import { bookingFollowUpAnchorId, parseInterviewTimestamp } from './scenario-registry';
import type { FollowUpScenarioCode, ReengagementChannelIdentity } from './reengagement.types';

interface AnchorContext {
  traceId: string;
  chatId: string;
  userId: string;
  corpId: string;
  isGroupChat?: boolean;
  /** 渠道身份快照（候选人昵称/接管 bot），随触达记录落库供追溯页直读。 */
  channelIdentity?: ReengagementChannelIdentity;
}

interface AnchorAgentResult {
  reply?: { content?: string };
  text?: string;
  toolCalls?: AgentToolCall[];
  outcome?: { kind: string };
}

type ReengagementState = AuthoritativeSessionState & { interviewAt?: number };

@Injectable()
export class ReengagementAnchorService {
  private readonly logger = new Logger(ReengagementAnchorService.name);

  constructor(
    private readonly scheduler: FollowUpSchedulerService,
    private readonly session: SessionService,
  ) {}

  handleToolAnchors(result: AnchorAgentResult, context: AnchorContext): void {
    if (context.isGroupChat) return;
    // lastCandidateMessageAt（「锚点后已回话」停止信号）由入站接收层刷新：
    // accept-inbound-message.service 在消息进入时按回调时间戳调 recordCandidateActivity，
    // 比在这里（Agent 生成完成后）更早且带真实消息时间，此处不再重复写。
    const toolCalls = result.toolCalls ?? [];
    const deliverable = this.isDeliverable(result);
    if (deliverable && toolCalls.some((call) => this.isCollectionStarted(call))) {
      void this.schedule('booking_incomplete', `${context.traceId}:collection_started`, context);
    }

    // 取消工单成功：booked 终态回退（候选人回到求职中，报名前场景恢复可排程）。
    // 在途的旧面试提醒不在这里清（Bull 不支持按会话检索），由 processor 到点向海绵
    // 核验工单现状兜底（external_cancelled）。不依赖 deliverable：工单已实际取消。
    const cancelSucceeded = toolCalls.some((call) => this.isCancelSucceeded(call));
    const booking = toolCalls.find((call) => this.isBookingSucceeded(call));
    // 终态写入必须串行：同回合先取消旧工单再报新岗位（换岗）时，clear 的读-判-写
    // 若与新 booked 写入并发，可能落在其后抹掉刚写的终态，导致带活面试的会话被
    // 报名前场景继续骚扰。链上顺序 = 工具调用顺序（先 clear 后 booked）。
    let terminalChain: Promise<void> = Promise.resolve();
    if (cancelSucceeded) {
      terminalChain = terminalChain.then(() => this.clearBookedTerminal(context));
    }
    if (booking) {
      terminalChain = terminalChain.then(() =>
        this.session
          .saveTerminalState(context.corpId, context.userId, context.chatId, 'booked')
          .catch((error) => this.logFailure('save booked terminal', context, error)),
      );
    }
    void terminalChain;

    // 改约成功：按新面试时间排新的提醒/回访（新锚点）。旧任务携带的 expectedInterviewAt
    // 与更新后的 active_booking.interview_time 不再一致，到点被 interview_time_changed 停掉。
    const modified = toolCalls.find((call) => this.isInterviewModified(call));
    if (modified && deliverable) {
      this.scheduleBookingFollowUps(modified, `${context.traceId}:interview_modified`, context);
    }

    if (!booking || !deliverable) return;
    this.scheduleBookingFollowUps(booking, `${context.traceId}:booking_succeeded`, context);
  }

  /**
   * booking / 改约共用：按工具调用里的面试时间与工单号排面试提醒 + 面试后回访。
   *
   * 有工单号+面试时间时用幂等锚点（wo:iv:scenario）：同一工单同一时间只存在一个任务，
   * 与 processor 到点发现改期后排的替代任务共用 jobId 自然去重。
   * 缺任一（等通知报名/提取失败）回退 traceId 锚点。
   */
  private scheduleBookingFollowUps(
    call: AgentToolCall,
    anchorEventBase: string,
    context: AnchorContext,
  ): void {
    const interviewAt = this.extractInterviewAt(call);
    const workOrderId = this.extractWorkOrderId(call);
    const stateOverride: Partial<ReengagementState> | undefined =
      interviewAt === undefined ? undefined : { terminal: 'booked', interviewAt };
    const verification = { workOrderId, expectedInterviewAt: interviewAt };
    const anchorIdFor = (scenarioCode: FollowUpScenarioCode): string =>
      workOrderId != null && interviewAt != null
        ? bookingFollowUpAnchorId(workOrderId, interviewAt, scenarioCode)
        : `${anchorEventBase}:${scenarioCode}`;
    void this.schedule(
      'interview_reminder',
      anchorIdFor('interview_reminder'),
      context,
      stateOverride,
      verification,
    );
    void this.schedule(
      'post_interview_followup',
      anchorIdFor('post_interview_followup'),
      context,
      stateOverride,
      verification,
    );
  }

  /**
   * 取消工单后回退 booked 终态（只在当前是 booked 时清，避免误清 handed_off 等其他终态）。
   * 注意多工单并存时的取舍：任一工单取消都会回退终态，报名后场景的有效性由到点核验按
   * workOrderId 精确判断，不受此影响。
   */
  private async clearBookedTerminal(context: AnchorContext): Promise<void> {
    try {
      const state = await this.loadState(context);
      if (state.terminal !== 'booked') return;
      // saveTerminalState 内部 `terminal ?? null`：传 undefined 即清空落库
      await this.session.saveTerminalState(
        context.corpId,
        context.userId,
        context.chatId,
        undefined,
      );
    } catch (error) {
      this.logFailure('clear booked terminal after cancel', context, error);
    }
  }

  handleDeliveredReplyAnchors(result: AnchorAgentResult, context: AnchorContext): void {
    if (context.isGroupChat) return;
    const reply = (result.reply?.content ?? result.text ?? '').trim();
    const toolCalls = result.toolCalls ?? [];

    if (toolCalls.some((call) => this.presentedStore(call))) {
      void this.schedule('store_presented_no_reply', `${context.traceId}:store_presented`, context);
    }
    if (this.asksForLocation(reply)) {
      void this.schedule('address_missing', `${context.traceId}:address_missing`, context);
    }
  }

  private isDeliverable(result: AnchorAgentResult): boolean {
    return !result.outcome || result.outcome.kind === 'reply';
  }

  private async schedule(
    scenarioCode: FollowUpScenarioCode,
    anchorEventId: string,
    context: AnchorContext,
    stateOverride?: Partial<ReengagementState>,
    verification?: { workOrderId?: number; expectedInterviewAt?: number },
  ): Promise<void> {
    try {
      const state = await this.loadState(context);
      await this.scheduler.scheduleFollowUp({
        sessionRef: {
          corpId: context.corpId,
          userId: context.userId,
          sessionId: context.chatId,
        },
        scenarioCode,
        anchorEventId,
        anchorAt: Date.now(),
        state: { ...state, ...stateOverride },
        workOrderId: verification?.workOrderId,
        expectedInterviewAt: verification?.expectedInterviewAt,
        channelIdentity: context.channelIdentity,
      });
    } catch (error) {
      this.logFailure(`schedule ${scenarioCode}`, context, error);
    }
  }

  private async loadState(context: AnchorContext): Promise<ReengagementState> {
    const session = this.session as SessionService & {
      getAuthoritativeState?: SessionService['getAuthoritativeState'];
    };
    if (typeof session.getAuthoritativeState === 'function') {
      return (await session.getAuthoritativeState(
        context.corpId,
        context.userId,
        context.chatId,
      )) as ReengagementState;
    }
    return {
      collectedFields: {},
      recalledJobIds: new Set<number>(),
      hardConstraints: [],
      presentedStores: [],
      stage: null,
    };
  }

  private isCollectionStarted(call: AgentToolCall): boolean {
    if (call.toolName !== 'duliday_interview_precheck') return false;
    const result = this.asRecord(call.result);
    if (!result) return false;
    if (result.nextAction === 'collect_fields') return true;
    const checklist = this.asRecord(result.bookingChecklist);
    return Array.isArray(checklist?.missingFields) && checklist.missingFields.length > 0;
  }

  private isBookingSucceeded(call: AgentToolCall): boolean {
    if (call.toolName !== 'duliday_interview_booking') return false;
    const result = this.asRecord(call.result);
    return result?.success === true || typeof result?.workOrderId === 'number';
  }

  private isCancelSucceeded(call: AgentToolCall): boolean {
    if (call.toolName !== 'duliday_cancel_work_order') return false;
    return this.asRecord(call.result)?.success === true;
  }

  private isInterviewModified(call: AgentToolCall): boolean {
    if (call.toolName !== 'duliday_modify_interview_time') return false;
    return this.asRecord(call.result)?.success === true;
  }

  private extractWorkOrderId(call: AgentToolCall): number | undefined {
    const args = this.asRecord(call.args);
    const result = this.asRecord(call.result);
    const raw = result?.workOrderId ?? args?.workOrderId;
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
  }

  private presentedStore(call: AgentToolCall): boolean {
    if (call.toolName !== 'duliday_job_list') return false;
    const result = this.asRecord(call.result);
    if (!result) return false;
    if (typeof result.resultCount === 'number') return result.resultCount > 0;
    return ['jobs', 'items', 'data', 'results', 'list'].some((key) => {
      const value = result[key];
      return Array.isArray(value) && value.length > 0;
    });
  }

  private asksForLocation(reply: string): boolean {
    return /发.*(?:位置|地址)|(?:位置|地址).*发|附近|就近/.test(reply);
  }

  private extractInterviewAt(call: AgentToolCall): number | undefined {
    const args = this.asRecord(call.args);
    const result = this.asRecord(call.result);
    // newInterviewTime：duliday_modify_interview_time 改约工具的入参/返回字段
    const raw =
      args?.interviewTime ??
      args?.newInterviewTime ??
      result?.interviewTime ??
      result?.newInterviewTime ??
      result?.interviewAt;
    return parseInterviewTimestamp(raw);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private logFailure(action: string, context: AnchorContext, error: unknown): void {
    this.logger.warn(
      `[reengagement] ${action} failed: chatId=${context.chatId}, traceId=${context.traceId}, error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
