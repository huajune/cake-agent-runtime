import { Injectable, Logger } from '@nestjs/common';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import { SessionService } from '@memory/services/session.service';
import {
  FollowUpSchedulerService,
  type ReengagementChannelIdentity,
} from './follow-up-scheduler.service';
import { type FollowUpScenarioCode } from './scenario-registry';

interface AnchorContext {
  traceId: string;
  chatId: string;
  userId: string;
  corpId: string;
  isGroupChat?: boolean;
  /** 渠道身份快照（候选人昵称/接管 bot），随触达记录落库供追溯页直读。 */
  channelIdentity?: ReengagementChannelIdentity;
  /** 首条开场回复不排缺定位，避免开场未回后再连续触发缺定位。 */
  suppressAddressMissing?: boolean;
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
    // 核验工单是否仍为进行中状态兜底。不依赖 deliverable：工单已实际取消。
    const cancelSucceeded = toolCalls.some((call) => this.isCancelSucceeded(call));
    const booking = toolCalls.find((call) => this.isBookingSucceeded(call));
    const groupInvited = toolCalls.some((call) => this.isGroupInviteSucceeded(call));
    if (groupInvited) {
      void this.scheduler.stopPendingJobsForSessionScenario({
        sessionRef: {
          corpId: context.corpId,
          userId: context.userId,
          sessionId: context.chatId,
        },
        scenarioCode: 'store_presented_no_reply',
        reason: 'candidate_invited_to_group',
      });
    }
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

    // 改约成功：新锚点只触发面试排程解析；正式提醒/回访按海绵返回的新时间重排。
    // 旧任务到点也会重新查同一工单，并因实时触发时间变化而停止或替换。
    const modified = toolCalls.find((call) => this.isInterviewModified(call));
    if (modified && deliverable) {
      this.scheduleBookingFollowUps(modified, `${context.traceId}:interview_modified`, context);
    }

    if (!booking || !deliverable) return;
    this.scheduleBookingFollowUps(booking, `${context.traceId}:booking_succeeded`, context);
  }

  /**
   * booking / 改约共用：只把稳定工单号送入解析重试任务。正式触达时间必须由 worker
   * 查询海绵实时工单后计算，禁止使用预约工具入参或旧任务快照。
   */
  private scheduleBookingFollowUps(
    call: AgentToolCall,
    anchorEventBase: string,
    context: AnchorContext,
  ): void {
    const workOrderId = this.extractWorkOrderId(call);
    if (workOrderId == null) return;
    for (const scenarioCode of ['interview_reminder', 'post_interview_followup'] as const) {
      void this.scheduler.scheduleBookingResolution({
        sessionRef: {
          corpId: context.corpId,
          userId: context.userId,
          sessionId: context.chatId,
        },
        scenarioCode,
        workOrderId,
        anchorEventId: `${anchorEventBase}:${scenarioCode}`,
        anchorAt: Date.now(),
        channelIdentity: context.channelIdentity,
      });
    }
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

    // 候选人进入收资后仍可能追问薪资、排班、福利。回复若继续明确索要资料，应刷新
    // 收资锚点，不能因为同轮补查岗位详情而降级成“推店未回”。首次 precheck 已由
    // handleToolAnchors 排程，避免同一回合重复创建第二个收资锚点。
    const collectionStartedThisTurn = toolCalls.some((call) => this.isCollectionStarted(call));
    const collectionContinued = !collectionStartedThisTurn && this.asksForCollectionDetails(reply);
    const groupInvitedThisTurn = toolCalls.some((call) => this.isGroupInviteSucceeded(call));
    if (collectionContinued) {
      void this.schedule('booking_incomplete', `${context.traceId}:collection_continued`, context);
    }

    const presentedStoreCalls =
      collectionContinued || groupInvitedThisTurn
        ? []
        : toolCalls.filter((call) => this.presentedStore(call, reply));
    if (presentedStoreCalls.length > 0) {
      void this.schedule(
        'store_presented_no_reply',
        `${context.traceId}:store_presented`,
        context,
        { presentedStores: this.extractPresentedStores(presentedStoreCalls) },
      );
    }
    if (!context.suppressAddressMissing && this.asksForLocation(reply)) {
      void this.scheduler.removeSupersededPendingJobs({
        sessionRef: {
          corpId: context.corpId,
          userId: context.userId,
          sessionId: context.chatId,
        },
        scenarioCode: 'address_missing',
        reason: 'address_missing_supersedes_opening_no_reply',
      });
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
    verification?: {
      workOrderId?: number;
      expectedInterviewAt?: number;
      interviewType?: string;
    },
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
        interviewType: verification?.interviewType,
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

  private isGroupInviteSucceeded(call: AgentToolCall): boolean {
    if (call.toolName !== 'invite_to_group') return false;
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

  private presentedStore(call: AgentToolCall, reply: string): boolean {
    if (call.toolName !== 'duliday_job_list') return false;
    const args = this.asRecord(call.args);
    // 带明确 jobId 的查询是在已选岗位上补查薪资、排班、福利等事实，不是重新推店。
    // 若把这种查询也当成展示门店，会在收资阶段错误排出 store_presented_no_reply。
    if (Array.isArray(args?.jobIdList) && args.jobIdList.length > 0) return false;
    const result = this.asRecord(call.result);
    if (!result) return false;
    const hasResults =
      (typeof result.resultCount === 'number' && result.resultCount > 0) ||
      ['jobs', 'items', 'data', 'results', 'list'].some((key) => {
        const value = result[key];
        return Array.isArray(value) && value.length > 0;
      });
    if (!hasResults) return false;

    // 查到岗位不等于已经向候选人展示岗位。只有回复里出现结果中的具体品牌/门店/岗位，
    // 或包含结构化岗位卡片，才建立“推店未回”锚点。这样能排除“暂无合适岗位”、
    // “年龄不匹配”“进群等新岗”等查岗后未实际推荐的回复。
    const labels = new Set<string>();
    this.collectPresentationLabels(call.result, labels);
    const mentionsResult = [...labels].some((label) => label.length >= 2 && reply.includes(label));
    const containsJobCard =
      /薪资\s*[:：]?\s*(?:\d|[一二三四五六七八九十])|(?:班次|要求|福利)\s*[:：]|[（(][^）)]+[）)]\s*[-—]/.test(
        reply,
      );
    const containsPositiveHandoff =
      /(?:这家|这个岗位|哪家|哪个岗位).{0,20}(?:考虑|感兴趣|合适|方便|接受|帮你约)|(?:考虑|感兴趣|合适).{0,12}(?:这家|这个岗位)/.test(
        reply,
      );
    return containsJobCard || (mentionsResult && containsPositiveHandoff);
  }

  private collectPresentationLabels(value: unknown, out: Set<string>, depth = 0): void {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) this.collectPresentationLabels(item, out, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (
        ['brandName', 'storeName', 'projectName', 'jobName'].includes(key) &&
        typeof nested === 'string' &&
        nested.trim().length > 0
      ) {
        out.add(nested.trim());
      }
      this.collectPresentationLabels(nested, out, depth + 1);
    }
  }

  private extractPresentedStores(
    calls: AgentToolCall[],
  ): AuthoritativeSessionState['presentedStores'] {
    const jobIds = new Set<number>();
    for (const call of calls) {
      this.collectJobIds(call.result, jobIds);
    }
    const stores = [...jobIds].map((jobId) => ({ jobId }));
    // 本轮工具调用已经证明发生了推店；即使工具结果没有结构化 jobId，也要让排程预检通过。
    return stores.length > 0 ? stores : [{ jobId: -1 }];
  }

  private collectJobIds(value: unknown, out: Set<number>, depth = 0): void {
    if (depth > 6 || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) this.collectJobIds(item, out, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if ((key === 'jobId' || key === 'job_id') && typeof nested === 'number' && nested > 0) {
        out.add(nested);
      }
      this.collectJobIds(nested, out, depth + 1);
    }
  }

  private asksForLocation(reply: string): boolean {
    return /(?:你|您|方便|可以|麻烦|这边|这儿|那里|那边)?.{0,8}(?:发|给我发|提供|说下|说一下|告知|填).{0,12}(?:位置|地址|定位|地标|商圈|地铁站)|(?:位置|地址|定位|地标).{0,8}(?:发|给).{0,8}(?:我|这边)|(?:在哪|哪里).*?(?:城市|区|区域|商圈|地铁站|位置|地址|地标)|(?:城市|区|区域|商圈|地铁站|位置|地址|地标).*?(?:在哪|哪里)/.test(
      reply,
    );
  }

  private asksForCollectionDetails(reply: string): boolean {
    return /(?:资料|个人信息|报名信息).{0,16}(?:填|填写|补|补充|发我|给我|提供|登记)|(?:姓名|联系方式|手机号|电话|年龄|性别|面试时间).{0,30}(?:填|填写|补|补充|发我|给我|提供|登记)/.test(
      reply,
    );
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
