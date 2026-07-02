import { Injectable, Logger } from '@nestjs/common';
import type { AgentToolCall } from '@agent/agent-run.types';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import { SessionService } from '@memory/services/session.service';
import { FollowUpSchedulerService } from './follow-up-scheduler.service';
import type { FollowUpScenarioCode } from './reengagement.types';

interface AnchorContext {
  traceId: string;
  chatId: string;
  userId: string;
  corpId: string;
  isGroupChat?: boolean;
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
    // 每个入站轮都是候选人活动：刷新 lastCandidateMessageAt，让 shouldStop 的
    // 「锚点后已回话」停止条件有真实信号（主动复聊轮不走本方法，不会误刷）。
    void this.session
      .recordCandidateActivity(context.corpId, context.userId, context.chatId)
      .catch((error) => this.logFailure('record candidate activity', context, error));
    const toolCalls = result.toolCalls ?? [];
    const deliverable = this.isDeliverable(result);
    if (deliverable && toolCalls.some((call) => this.isCollectionStarted(call))) {
      void this.schedule('booking_incomplete', `${context.traceId}:collection_started`, context);
    }

    const booking = toolCalls.find((call) => this.isBookingSucceeded(call));
    if (!booking) return;
    void this.session
      .saveTerminalState(context.corpId, context.userId, context.chatId, 'booked')
      .catch((error) => this.logFailure('save booked terminal', context, error));

    if (!deliverable) return;
    const interviewAt = this.extractInterviewAt(booking);
    const stateOverride: Partial<ReengagementState> | undefined =
      interviewAt === undefined ? undefined : { terminal: 'booked', interviewAt };
    void this.schedule(
      'interview_reminder',
      `${context.traceId}:booking_succeeded`,
      context,
      stateOverride,
    );
    void this.schedule(
      'post_interview_followup',
      `${context.traceId}:post_interview_followup`,
      context,
      stateOverride,
    );
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
    const raw = args?.interviewTime ?? result?.interviewTime ?? result?.interviewAt;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T') + '+08:00';
    const ts = Date.parse(normalized);
    return Number.isFinite(ts) ? ts : undefined;
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
