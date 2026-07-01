import { Injectable, Logger } from '@nestjs/common';
import type { AgentToolCall } from '@agent/generator/generator.types';
import { SessionService } from '@memory/services/session.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import {
  FollowUpSchedulerService,
  type ScheduleFollowUpInput,
} from './follow-up-scheduler.service';

export interface ReengagementAgentResult {
  reply: { content?: string };
  isSkipped?: boolean;
  guardrailBlocked?: unknown;
  toolCalls?: AgentToolCall[];
}

export interface ReengagementAnchorContext {
  traceId: string;
  chatId: string;
  userId: string;
  corpId: string;
  isGroupChat?: boolean;
}

@Injectable()
export class ReengagementAnchorService {
  private readonly logger = new Logger(ReengagementAnchorService.name);

  constructor(
    private readonly followUpScheduler: FollowUpSchedulerService,
    private readonly session: SessionService,
  ) {}

  handleToolAnchors(
    agentResult: ReengagementAgentResult,
    context: ReengagementAnchorContext,
  ): void {
    if (context.isGroupChat) return;
    const toolCalls = agentResult.toolCalls ?? [];
    if (toolCalls.length === 0) return;

    this.persistTerminalStateFromToolCalls(toolCalls, context);

    const candidateVisible = !agentResult.isSkipped && !agentResult.guardrailBlocked;
    if (!candidateVisible) return;

    const sessionRef = {
      corpId: context.corpId,
      userId: context.userId,
      sessionId: context.chatId,
    };

    const precheckCollect = toolCalls.find((call) => this.isPrecheckCollectFieldsCall(call));
    if (precheckCollect) {
      this.scheduleAnchor('booking_incomplete', sessionRef, context, 'collection_started');
    }

    const bookingSuccess = toolCalls.find((call) => this.isBookingSuccessCall(call));
    if (!bookingSuccess) return;

    const reminderState = this.buildInterviewReminderState(bookingSuccess);
    const anchorAt = Date.now();
    this.scheduleAnchor(
      'interview_reminder',
      sessionRef,
      context,
      'booking_succeeded',
      anchorAt,
      reminderState,
    );
    this.scheduleAnchor(
      'post_interview_followup',
      sessionRef,
      context,
      'post_interview_followup',
      anchorAt,
      reminderState,
    );
  }

  handleDeliveredReplyAnchors(
    agentResult: ReengagementAgentResult,
    context: ReengagementAnchorContext,
  ): void {
    if (context.isGroupChat) return;
    const content = agentResult.reply.content?.trim() ?? '';
    if (!content) return;

    const sessionRef = {
      corpId: context.corpId,
      userId: context.userId,
      sessionId: context.chatId,
    };
    const anchorAt = Date.now();

    if (this.replyPresentedJob(agentResult, content)) {
      this.scheduleAnchor(
        'store_presented_no_reply',
        sessionRef,
        context,
        'store_presented',
        anchorAt,
      );
    }

    if (this.replyRequestsLocation(content)) {
      this.scheduleAnchor('address_missing', sessionRef, context, 'address_missing', anchorAt);
    }
  }

  private scheduleAnchor(
    scenarioCode: ScheduleFollowUpInput['scenarioCode'],
    sessionRef: ScheduleFollowUpInput['sessionRef'],
    context: ReengagementAnchorContext,
    anchorSuffix: string,
    anchorAt = Date.now(),
    state?: AuthoritativeSessionState,
  ): void {
    const input: ScheduleFollowUpInput = {
      sessionRef,
      scenarioCode,
      anchorEventId: `${context.traceId}:${anchorSuffix}`,
      anchorAt,
      ...(state ? { state } : {}),
    };

    void this.followUpScheduler.scheduleFollowUp(input).catch((error: unknown) => {
      this.logger.warn(
        `[reengagement] ${scenarioCode} 锚点排程失败 [${context.traceId}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  private persistTerminalStateFromToolCalls(
    toolCalls: AgentToolCall[],
    context: ReengagementAnchorContext,
  ): void {
    const terminal = toolCalls.some((call) => this.isBookingSuccessCall(call))
      ? 'booked'
      : toolCalls.some((call) => this.isCommittedHandoffCall(call))
        ? 'handed_off'
        : null;
    if (!terminal) return;

    void this.session
      .saveTerminalState(context.corpId, context.userId, context.chatId, terminal)
      .catch((error: unknown) => {
        this.logger.warn(
          `[reengagement] terminal=${terminal} 写入失败 [${context.traceId}]: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  private isCommittedHandoffCall(call: AgentToolCall): boolean {
    if (call.toolName === 'request_handoff') {
      const result = this.asRecord(call.result);
      return result?.dispatched === true || result?.shortCircuited === true;
    }
    if (call.toolName === 'duliday_interview_booking') {
      const result = this.asRecord(call.result);
      return result?.gateRejected === true && result.shortCircuited === true;
    }
    return false;
  }

  private isPrecheckCollectFieldsCall(call: AgentToolCall): boolean {
    if (call.toolName !== 'duliday_interview_precheck') return false;
    const result = this.asRecord(call.result);
    if (result?.success !== true || result.nextAction !== 'collect_fields') return false;
    const checklist = this.asRecord(result.bookingChecklist);
    const missingFields = checklist?.missingFields;
    return Array.isArray(missingFields) && missingFields.length > 0;
  }

  private isBookingSuccessCall(call: AgentToolCall): boolean {
    if (call.toolName !== 'duliday_interview_booking') return false;
    const result = this.asRecord(call.result);
    return result?.success === true;
  }

  private replyPresentedJob(agentResult: ReengagementAgentResult, content: string): boolean {
    const jobListCalls =
      agentResult.toolCalls?.filter((call) => call.toolName === 'duliday_job_list') ?? [];
    if (jobListCalls.length === 0) return false;

    for (const call of jobListCalls) {
      const result = this.asRecord(call.result);
      if (!result) continue;
      if (typeof result.resultCount === 'number' && result.resultCount <= 0) continue;
      const markers = this.extractJobPresentationMarkers(result.markdown);
      if (markers.some((marker) => content.includes(marker))) return true;
    }

    return /岗位|门店|店|薪资|工资|上班|班次/.test(content);
  }

  private extractJobPresentationMarkers(markdown: unknown): string[] {
    if (typeof markdown !== 'string') return [];
    const markers = new Set<string>();
    const patterns = [
      /\*\*品牌\*\*[:：]\s*([^\n|，,（(]+)/g,
      /\*\*门店\*\*[:：]\s*([^\n|，,（(]+)/g,
      /\*\*地址\*\*[:：]\s*([^\n|，,（(]+)/g,
      /\|\s*([^|\n]{2,20}店)\s*\|/g,
      /##\s*\d+\.\s*([^\n]{2,40})/g,
    ];
    for (const pattern of patterns) {
      for (const match of markdown.matchAll(pattern)) {
        const raw = match[1]?.trim();
        if (!raw) continue;
        for (const part of raw.split(/[-—｜|/、\s]+/)) {
          const token = part.trim();
          if (token.length >= 2 && token.length <= 24) markers.add(token);
        }
      }
    }
    return Array.from(markers);
  }

  private replyRequestsLocation(content: string): boolean {
    return /(?:发|给|提供|补充).{0,8}(?:位置|定位|地址)|(?:位置|定位|地址).{0,8}(?:发|给|提供|补充)|附近/.test(
      content,
    );
  }

  private buildInterviewReminderState(call: AgentToolCall): AuthoritativeSessionState {
    const args = this.asRecord(call.args);
    const result = this.asRecord(call.result);
    const requestInfo = this.asRecord(result?.requestInfo);
    const rawInterviewTime =
      (typeof args?.interviewTime === 'string' && args.interviewTime) ||
      (typeof requestInfo?.interviewTime === 'string' && requestInfo.interviewTime) ||
      null;
    const interviewAt = rawInterviewTime ? this.parseShanghaiDateTime(rawInterviewTime) : null;

    return {
      collectedFields: {},
      recalledJobIds: new Set<number>(),
      hardConstraints: [],
      presentedStores: [],
      stage: null,
      terminal: 'booked',
      ...(interviewAt != null ? { interviewAt } : {}),
    } as AuthoritativeSessionState & { interviewAt?: number };
  }

  private parseShanghaiDateTime(value: string): number | null {
    const normalized = value.trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
    if (!match) return null;
    const [, y, mo, d, h, mi, s = '00'] = match;
    const ts = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`);
    return Number.isFinite(ts) ? ts : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }
}
