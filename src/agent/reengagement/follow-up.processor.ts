import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import {
  ReengagementTrackingService,
  type ReengagementTouchIdentity,
} from '@biz/monitoring/services/tracking/reengagement-tracking.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import { SessionService } from '@memory/services/session.service';
import { LongTermService } from '@memory/services/long-term.service';
import { SpongeService } from '@sponge/sponge.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import { CHANNEL_DELIVERY_PORT, type ChannelDeliveryPort } from './channel-delivery.port';
import { FollowUpSchedulerService } from './follow-up-scheduler.service';
import { AgentRunnerService } from '../runner/agent-runner.service';
import type { TurnOutcome } from '../runner/agent-runner.types';
import { TurnOutcomeInterventionService } from '../runner/turn-outcome-intervention.service';
import { REENGAGEMENT_JOB_NAME, REENGAGEMENT_QUEUE, type FollowUpJob } from './reengagement.types';
import {
  bookingFollowUpAnchorId,
  computeFireAt,
  getScenario,
  inWindow,
  parseInterviewTimestamp,
  resolveDelayMs,
  resolveRolloutEnabled,
  shouldStop,
} from './scenario-registry';
import { TouchLedgerService } from './touch-ledger.service';

/** 海绵工单 currentStatus（9 态中文）里代表报名已失效的状态（对所有报名后场景生效）。 */
const BOOKING_CANCELLED_STATUSES = new Set(['约面取消', '约面失败']);

/** 面试/上岗已发生的状态：面试提醒无意义应停；面试后回访不受影响（面试完成正是回访前提）。 */
const INTERVIEW_DONE_STATUSES = new Set(['面试成功', '面试失败', '上岗成功', '上岗失败', '已离职']);

/** 改期比对容差：active_booking.interview_time 与排程冻结时间差超过 1 分钟视为已改约。 */
const INTERVIEW_TIME_DRIFT_TOLERANCE_MS = 60_000;

/**
 * 复聊 TaskProcessor：到点 → 代码校验停止条件 → 复用 runner（继承 guardrail/记忆/观测）→ 投递。
 *
 * 开关走 Dashboard 运行时配置（DB 动态读，即时生效）：`reengagementEnabled` 是急刹车——
 * 关闭后在途 job 到点直接丢弃；`reengagementShadow`（第一版必跑）走完 shouldStop +
 * runner.runTurn 但**不 deliver**，只记"本应发 X / 命中场景 Y / 停止原因 Z"。
 * ⚠️ shadow ≠ 无副作用：主动回合已 toolMode:'readonly' 物理禁副作用工具（见 runner.runTurn），
 * shadow 再叠加"不投递"，两者缺一不可。
 */
@Injectable()
export class FollowUpProcessor implements OnModuleInit {
  private readonly logger = new Logger(FollowUpProcessor.name);

  constructor(
    @InjectQueue(REENGAGEMENT_QUEUE) private readonly queue: Queue<FollowUpJob>,
    private readonly session: SessionService,
    private readonly runner: AgentRunnerService,
    private readonly touchLedger: TouchLedgerService,
    private readonly systemConfig: SystemConfigService,
    private readonly outcomeFinalizer: TurnOutcomeInterventionService,
    private readonly tracking: ReengagementTrackingService,
    private readonly messageTracking: MessageTrackingService,
    private readonly sponge: SpongeService,
    private readonly longTerm: LongTermService,
    private readonly scheduler: FollowUpSchedulerService,
    @Optional()
    @Inject(CHANNEL_DELIVERY_PORT)
    private readonly delivery?: ChannelDeliveryPort<TurnOutcome>,
  ) {}

  onModuleInit(): void {
    this.queue.process(REENGAGEMENT_JOB_NAME, 2, (job: Job<FollowUpJob>) => this.process(job));
    this.logger.log(
      `[reengagement] processor 已注册（delivery=${this.delivery ? 'bound' : 'none'}，enabled/shadow 由运行时配置动态控制）`,
    );
  }

  async process(job: Job<FollowUpJob>): Promise<void> {
    const { sessionRef, scenarioCode, anchorAt, anchorEventId } = job.data;
    const scenario = getScenario(scenarioCode);
    if (!scenario) {
      this.logger.warn(`[reengagement] 未知场景 ${scenarioCode}，跳过`);
      return;
    }
    const identity: ReengagementTouchIdentity = {
      sessionId: sessionRef.sessionId,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      scenarioCode,
      anchorEventId,
      anchorAt,
      ...job.data.channelIdentity,
    };

    // 0) 总开关急刹车：Dashboard 关闭后，在途 job 到点直接丢弃（不生成、不投递、不重排）
    const runtime = await this.systemConfig.getAgentReplyConfig();
    if (!runtime.reengagementEnabled) {
      this.logger.log(
        `[reengagement] 总开关关闭，丢弃到点任务 ${scenarioCode} sessionId=${sessionRef.sessionId}`,
      );
      this.tracking.trackDisabledAtFire(identity);
      return;
    }

    const now = Date.now();
    const state = await this.session.getAuthoritativeState(
      sessionRef.corpId,
      sessionRef.userId,
      sessionRef.sessionId,
    );

    // 1) 停止条件（代码，调 LLM 之前）
    const stop = shouldStop(scenario, state, anchorAt, {
      externallyVerifiable: job.data.workOrderId != null,
    });
    if (stop.stop) {
      this.logger.log(
        `[reengagement] 停止 ${scenarioCode} sessionId=${sessionRef.sessionId} 原因=${stop.reason}`,
      );
      this.tracking.trackStopped(identity, stop.reason ?? 'stopped');
      return;
    }

    // 1.5) 报名后场景到点核验：向海绵查工单现状（外部取消/已面试）+ 比对面试时间是否改约。
    // 会话内检测不到的后台操作在这里兜底；核验数据拿不到时按现状放行（不静默丢提醒）。
    if (scenario.anchorEvent === 'booking.succeeded' && job.data.workOrderId != null) {
      const invalidReason = await this.checkBookingInvalidAtFire(job.data, state);
      if (invalidReason) {
        this.logger.log(
          `[reengagement] 停止 ${scenarioCode} sessionId=${sessionRef.sessionId} 原因=${invalidReason}`,
        );
        this.tracking.trackStopped(identity, invalidReason);
        return;
      }
    }

    // 2) 频控：24h ≤ 2（只数 sent）
    if (await this.touchLedger.isOverFrequencyLimit(sessionRef.sessionId, now)) {
      this.logger.log(`[reengagement] 频控丢弃 ${scenarioCode} sessionId=${sessionRef.sessionId}`);
      this.tracking.trackFrequencyBlocked(identity);
      return;
    }

    // 3) 9-21 窗口二次确认（防 delay 漂移）；不在窗口 → 推到下一窗口
    if (!inWindow(now)) {
      await this.reschedule(job, scenario, state, anchorAt);
      return;
    }

    // 4) 投递 + 触达底账（shadow 只记不发）
    // 无投递端口绑定时强制 shadow；否则读运行时配置（与开头的总开关同一次读取）。
    // 所有未投递分支的 runTurnEnd 一律 includeAssistantText:false：候选人没收到这条文本，
    // 若照常投影成助手轮次，下一轮真实对话会引用一段候选人从未见过的"跟进"（HC-4 幽灵回复）。
    // 场景级灰度（Dashboard 可配）：场景开关 × 报名后大开关叠加
    const rolloutEnabled = resolveRolloutEnabled(scenario, runtime);
    const shadow = !this.delivery || runtime.reengagementShadow;
    if (shadow || !rolloutEnabled || !this.delivery) {
      const outcome = await this.runProactiveTurn(sessionRef, scenarioCode, scenario);
      this.logger.log(
        `[reengagement][SHADOW] 本应发: scenario=${scenarioCode} sessionId=${sessionRef.sessionId} ` +
          `text="${outcome.kind === 'reply' ? outcome.reply?.text.slice(0, 60) : `[${outcome.kind}]`}"` +
          `（shadow=${shadow}, rollout=${rolloutEnabled}）`,
      );
      this.tracking.trackShadow(identity, {
        outcomeKind: outcome.kind,
        generatedText: outcome.kind === 'reply' ? outcome.reply?.text : undefined,
        reason: !this.delivery
          ? 'no_delivery_port'
          : !rolloutEnabled
            ? 'rollout_disabled'
            : 'shadow_mode',
      });
      if (outcome.runTurnEnd) await outcome.runTurnEnd({ includeAssistantText: false });
      return;
    }

    const key = `${sessionRef.sessionId}:${scenarioCode}:${anchorAt}`;
    const slot = await this.touchLedger.reserve(key);
    if (slot === 'duplicate_sent') {
      // 之前那次触达已送达，但**本次生成的文本**没发出去——不投影本次文本。
      this.logger.log(`[reengagement] 已发过，跳过 key=${key}`);
      this.tracking.trackDuplicate(identity, slot);
      return;
    }
    if (slot === 'duplicate_inflight') {
      this.logger.warn(`[reengagement] 触达已在途/状态不明，跳过重投 key=${key}`);
      this.tracking.trackDuplicate(identity, slot);
      return;
    }
    this.tracking.trackReserved(identity);

    // 投递路径的主动回合在消息处理流水落一行（message_id = batchId），
    // 追溯页凭触达记录上的 batch_id 直接跳到该回合的完整生成轨迹。
    const batchId = `batch_${sessionRef.sessionId}_${now}`;
    const outcome = await this.runProactiveTurn(sessionRef, scenarioCode, scenario, batchId);
    if (outcome.kind !== 'reply' || !outcome.reply) {
      this.logger.log(
        `[reengagement] 回合非 reply（${outcome.kind}）→ 不投递 ${scenarioCode} sessionId=${sessionRef.sessionId}`,
      );
      this.tracking.trackOutcomeNotReply(identity, outcome.kind, batchId);
      this.messageTracking.recordProactiveTurn(
        this.buildProactiveTurnRecord({
          batchId,
          sessionRef,
          scenario,
          outcome,
          receivedAt: now,
          status: 'success',
          replyPreview: `[未投递:${outcome.kind}]`,
          channelIdentity: job.data.channelIdentity,
        }),
      );
      await this.outcomeFinalizer.commit(outcome, {
        traceId: key,
        chatId: sessionRef.sessionId,
        userId: sessionRef.userId,
        corpId: sessionRef.corpId,
        userMessage: `[系统主动跟进:${scenarioCode}]`,
      });
      await this.touchLedger.markFailedOrUnknown(key, 'failed');
      return;
    }

    await this.outboxDeliverReserved(outcome, key, sessionRef.sessionId, now, identity, batchId);
  }

  /**
   * 报名后场景到点核验（shouldStop 之后、生成之前）。返回失效原因；仍有效返回 null。
   *
   * - 海绵工单现状（source of truth，5min 缓存）：约面取消/约面失败 → 报名已失效；
   *   面试提醒额外拦已面试/已上岗（提醒已无意义），面试后回访不拦（面试完成正是回访前提）。
   * - 改期比对：当前约面时间优先取海绵下发的 interviewTime（后台改时间也能发现，
   *   2026-07 与海绵约定新增；老响应无此字段），缺失时回退本地 active_booking.interview_time
   *   （只覆盖聊天改约）。与排程时冻结的 expectedInterviewAt 不一致 → 先按新时间排
   *   替代任务（幂等锚点，与聊天改约锚点排的任务同 jobId 去重），再停旧任务。
   * - 任何核验数据拿不到（海绵异常/无指针/无字段）→ 放行：宁可按现状发，不静默丢提醒。
   */
  private async checkBookingInvalidAtFire(
    jobData: FollowUpJob,
    state: AuthoritativeSessionState,
  ): Promise<string | null> {
    const { sessionRef, scenarioCode, workOrderId, expectedInterviewAt } = jobData;
    if (workOrderId == null) return null;

    // getCachedWorkOrderById 内部吞错返回 null，此处再兜一层防御
    let currentStatus: string | null = null;
    let spongeInterviewAt: number | undefined;
    try {
      const workOrder = await this.sponge.getCachedWorkOrderById(workOrderId);
      currentStatus = workOrder?.currentStatus ?? null;
      spongeInterviewAt = parseInterviewTimestamp(workOrder?.interviewTime);
    } catch (error) {
      this.logger.warn(
        `[reengagement] 工单现状核验失败，按现状放行 workOrderId=${workOrderId}: ${this.errorMessage(error)}`,
      );
    }
    if (currentStatus) {
      if (BOOKING_CANCELLED_STATUSES.has(currentStatus)) {
        return `external_cancelled:${currentStatus}`;
      }
      if (scenarioCode === 'interview_reminder' && INTERVIEW_DONE_STATUSES.has(currentStatus)) {
        return `interview_already_done:${currentStatus}`;
      }
    }

    if (expectedInterviewAt == null) return null;
    let currentInterviewAt = spongeInterviewAt;
    if (currentInterviewAt == null) {
      const bookings = await this.longTerm.getActiveBookings(sessionRef.corpId, sessionRef.userId);
      const target = bookings.find((booking) => booking.work_order_id === workOrderId);
      currentInterviewAt = parseInterviewTimestamp(target?.interview_time);
    }
    if (
      currentInterviewAt != null &&
      Math.abs(currentInterviewAt - expectedInterviewAt) > INTERVIEW_TIME_DRIFT_TOLERANCE_MS
    ) {
      await this.scheduleTimeChangedReplacement(jobData, state, currentInterviewAt);
      return 'interview_time_changed';
    }
    return null;
  }

  /**
   * 改期后的替代任务：按新面试时间重排同场景跟进。
   *
   * 锚点用 bookingFollowUpAnchorId（wo:iv:scenario）——聊天改约走 anchor.service 已排过时
   * Bull 同 jobId 去重，本次排程 no-op；后台改时间（无聊天锚点）时这里是唯一的补排入口。
   * 面试提醒仅在新时间未过期时补排（给已过期的面试发提醒有害无益）；回访不受此限
   * （面试已发生正是回访时机）。排程失败只告警不阻断停止决策：宁可少发不误发。
   */
  private async scheduleTimeChangedReplacement(
    jobData: FollowUpJob,
    state: AuthoritativeSessionState,
    newInterviewAt: number,
  ): Promise<void> {
    const { sessionRef, scenarioCode, workOrderId } = jobData;
    if (workOrderId == null) return;
    if (scenarioCode === 'interview_reminder' && newInterviewAt <= Date.now()) return;
    try {
      await this.scheduler.scheduleFollowUp({
        sessionRef,
        scenarioCode,
        anchorEventId: bookingFollowUpAnchorId(workOrderId, newInterviewAt, scenarioCode),
        anchorAt: Date.now(),
        state: {
          ...state,
          terminal: 'booked',
          interviewAt: newInterviewAt,
        } as AuthoritativeSessionState,
        workOrderId,
        expectedInterviewAt: newInterviewAt,
      });
    } catch (error) {
      this.logger.warn(
        `[reengagement] 改期替代任务排程失败 workOrderId=${workOrderId} scenario=${scenarioCode}: ${this.errorMessage(error)}`,
      );
    }
  }

  private runProactiveTurn(
    sessionRef: FollowUpJob['sessionRef'],
    scenarioCode: string,
    scenario: NonNullable<ReturnType<typeof getScenario>>,
    messageId?: string,
  ): Promise<TurnOutcome> {
    const directive = `${scenario.objective}。生成要求：${scenario.generationPolicy}`;
    return this.runner.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive, scenarioCode },
      toolMode: 'readonly',
      context: messageId ? { messageId } : undefined,
    });
  }

  /** 主动回合的消息处理流水行（message_id = batchId，供追溯页跳转排障） */
  private buildProactiveTurnRecord(params: {
    batchId: string;
    sessionRef: FollowUpJob['sessionRef'];
    scenario: NonNullable<ReturnType<typeof getScenario>>;
    outcome: TurnOutcome;
    receivedAt: number;
    status: 'success' | 'failure';
    replyPreview?: string;
    error?: string;
    channelIdentity?: FollowUpJob['channelIdentity'];
  }): MessageProcessingRecordInput {
    const { batchId, sessionRef, scenario, outcome } = params;
    return {
      messageId: batchId,
      batchId,
      chatId: sessionRef.sessionId,
      userId: sessionRef.userId,
      userName: params.channelIdentity?.candidateName,
      managerName: params.channelIdentity?.managerName,
      botImId: params.channelIdentity?.botImId,
      receivedAt: params.receivedAt,
      status: params.status,
      scenario: `reengagement:${scenario.code}`,
      messagePreview: `[主动跟进] ${scenario.displayName}`,
      replyPreview: params.replyPreview,
      error: params.error,
      toolCalls: outcome.toolCalls,
      agentSteps: outcome.agentSteps,
      memorySnapshot: outcome.memorySnapshot,
      guardrailOutput: outcome.guardrailTrace,
      tokenUsage: outcome.usage?.totalTokens,
    };
  }

  /** outbox 状态机投递：reserved → attempted → sent / unknown。 */
  private async outboxDeliverReserved(
    outcome: TurnOutcome,
    key: string,
    sessionId: string,
    now: number,
    identity: ReengagementTouchIdentity,
    batchId: string,
  ): Promise<void> {
    const sessionRef = { sessionId, userId: identity.userId ?? '', corpId: identity.corpId ?? '' };
    const scenario = getScenario(identity.scenarioCode as FollowUpJob['scenarioCode']);
    const channelIdentity: FollowUpJob['channelIdentity'] = {
      candidateName: identity.candidateName,
      managerName: identity.managerName,
      botImId: identity.botImId,
    };
    try {
      await this.touchLedger.markDeliveryAttempted(key);
      this.tracking.trackDeliveryAttempted(identity);
      await this.delivery!.deliver(outcome, { idempotencyKey: key });
      await this.touchLedger.markSent(key, sessionId, now);
      this.tracking.trackSent(identity, outcome.reply?.text, batchId);
      if (scenario) {
        this.messageTracking.recordProactiveTurn(
          this.buildProactiveTurnRecord({
            batchId,
            sessionRef,
            scenario,
            outcome,
            receivedAt: now,
            status: 'success',
            replyPreview: outcome.reply?.text,
            channelIdentity,
          }),
        );
      }
    } catch (error) {
      // deliver 后状态不明 → unknown，交补偿，不盲重投。送达与否未知时按未送达处理：
      // 宁可下一轮重复跟进语气，也不能让记忆引用候选人可能没收到的文本（HC-4）。
      this.tracking.trackDeliveryUnknown(identity, this.errorMessage(error), batchId);
      if (scenario) {
        this.messageTracking.recordProactiveTurn(
          this.buildProactiveTurnRecord({
            batchId,
            sessionRef,
            scenario,
            outcome,
            receivedAt: now,
            status: 'failure',
            replyPreview: outcome.reply?.text,
            error: this.errorMessage(error),
            channelIdentity,
          }),
        );
      }
      try {
        await this.touchLedger.markFailedOrUnknown(key, 'unknown');
      } finally {
        await outcome.runTurnEnd?.({ includeAssistantText: false });
      }
      throw error;
    }

    try {
      await outcome.runTurnEnd?.({ includeAssistantText: true });
    } catch (error) {
      this.logger.warn(
        `[reengagement] turn-end lifecycle 执行失败，不改写触达状态: key=${key}, error=${this.errorMessage(error)}`,
      );
    }
    this.logger.log(`[reengagement] 已投递 key=${key}`);
  }

  /** 不在窗口：推到下一个 9-21 窗口重排（不消费 attempts）。 */
  private async reschedule(
    job: Job<FollowUpJob>,
    scenario: ReturnType<typeof getScenario>,
    state: Parameters<typeof resolveDelayMs>[1]['state'],
    anchorAt: number,
  ): Promise<void> {
    if (!scenario) return;
    const nextAnchorAt = Math.max(Date.now(), anchorAt);
    const fireAt = computeFireAt(scenario, { anchorAt: nextAnchorAt, state });
    const delay = Math.max(0, fireAt - Date.now());
    const jobId = `${job.id}:rw:${fireAt}`;
    const rescheduledData: FollowUpJob = { ...job.data };
    await this.queue.add(REENGAGEMENT_JOB_NAME, rescheduledData, {
      jobId,
      delay,
      attempts: 2,
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: { age: 3 * 24 * 60 * 60, count: 200 },
      removeOnFail: { age: 3 * 24 * 60 * 60, count: 200 },
    });
    this.logger.log(
      `[reengagement] 非投递窗口，推迟到 ${new Date(fireAt).toISOString()} 重判 jobId=${job.id} rescheduledJobId=${jobId}`,
    );
    this.tracking.trackRescheduled(
      {
        sessionId: job.data.sessionRef.sessionId,
        userId: job.data.sessionRef.userId,
        corpId: job.data.sessionRef.corpId,
        scenarioCode: job.data.scenarioCode,
        anchorEventId: job.data.anchorEventId,
        anchorAt: job.data.anchorAt,
      },
      fireAt,
      jobId,
    );
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
