import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { ConfigService } from '@nestjs/config';
import {
  ReengagementTrackingService,
  type ReengagementTouchIdentity,
} from '@biz/monitoring/services/tracking/reengagement-tracking.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import type { MessageProcessingRecordInput } from '@biz/message/types/message.types';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { isHumanAgentTextMessage } from '@biz/message/utils/message-provenance.util';
import { SessionService } from '@memory/services/session.service';
import { LongTermService } from '@memory/services/long-term.service';
import { SpongeService } from '@sponge/sponge.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';
import { MessageDeliveryService } from '@wecom/message/delivery/delivery.service';
import type { DeliveryContext, DeliveryResult } from '@wecom/message/types';
import type { TurnOutcome } from '../runner/agent-runner.types';
import {
  FollowUpSchedulerService,
  REENGAGEMENT_JOB_NAME,
  REENGAGEMENT_QUEUE,
  type FollowUpJob,
} from './follow-up-scheduler.service';
import {
  bookingFollowUpAnchorId,
  computeFireAt,
  getScenario,
  resolveRolloutEnabled,
  shouldStop,
} from './scenario-registry';
import { TouchLedgerService } from './touch-ledger.service';
import { evaluateOutOfBandWorkOrders, type OutOfBandWorkOrderVerdict } from './oob-work-order';
import { ReengagementAgent } from './reengagement.agent';
import type { ReengagementAgentExecution } from './reengagement.agent';
import {
  resolveReengagementBookingContext,
  type ReengagementBookingContext,
} from './booking-context';
import { BotService } from '@wecom/bot/bot.service';

export const REENGAGEMENT_DELIVERY_PORT = Symbol('REENGAGEMENT_DELIVERY_PORT');

export interface ReengagementDeliveryPort<TOutcome = unknown, TResult = unknown> {
  deliver(
    outcome: TOutcome,
    options?: { idempotencyKey?: string; context?: unknown },
  ): Promise<TResult>;
}

@Injectable()
export class ReengagementDeliveryService
  implements ReengagementDeliveryPort<TurnOutcome, DeliveryResult>
{
  constructor(
    private readonly delivery: MessageDeliveryService,
    private readonly botService: BotService,
  ) {}

  async deliver(
    outcome: TurnOutcome,
    options?: { idempotencyKey?: string; context?: DeliveryContext },
  ): Promise<DeliveryResult> {
    const text = outcome.reply?.text?.trim();
    if (outcome.kind !== 'reply' || !text) {
      throw new Error(`reengagement_delivery_non_reply:${outcome.kind}`);
    }
    const context = options?.context;
    if (!context?.token || !context.imBotId || !context.imContactId) {
      throw new Error('reengagement_delivery_missing_context');
    }

    // 复聊没有候选人入站消息可触发常规入口过滤，因此在真正投递前按接客 bot
    // 重新核验托管账号列表。查不到或上游查询失败均 fail closed，避免已取消托管的
    // 账号仍被历史 delayed job 主动发消息。
    if (!(await this.isReceivingBotHosted(context.imBotId))) {
      return {
        success: true,
        segmentCount: 0,
        failedSegments: 0,
        deliveredSegments: 0,
        totalTime: 0,
        skipped: true,
        skipReason: 'receiving_bot_not_hosted',
      };
    }

    return this.delivery.deliverReply(
      { content: text, reasoning: outcome.reasoning },
      context,
      false,
    );
  }

  private async isReceivingBotHosted(imBotId: string): Promise<boolean> {
    try {
      const bots = await this.botService.getConfiguredBotList();
      return bots.some((bot) =>
        [bot.wxid, bot.id, bot.weixin, bot.wecomUserId]
          .filter((id): id is string => typeof id === 'string')
          .some((id) => id.trim() === imBotId.trim()),
      );
    } catch {
      return false;
    }
  }
}

/**
 * 报名后复聊只允许仍处于约面阶段的工单。海绵 currentStatus 共 9 态；除以下两态外，
 * 其余状态都说明报名已经失败、取消，或面试结果/后续结果已经产生，不再提醒或追问。
 */
const ACTIVE_INTERVIEW_WORK_ORDER_STATUSES = new Set(['约面待确认', '约面成功']);

const BOOKING_SCHEDULE_TOLERANCE_MS = 60_000;

type ProactiveTurnExecution = ReengagementAgentExecution;

interface ProactiveDeliveryResult {
  success: boolean;
  segmentCount: number;
  failedSegments: number;
  deliveredSegments?: number;
  totalTime: number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * 复聊 TaskProcessor：到点 → 代码校验停止条件 → 复聊 agent 生成 → 投递。
 *
 * 开关走 Dashboard 运行时配置（DB 动态读，即时生效）：`reengagementEnabled` 是急刹车——
 * 关闭后在途 job 到点直接丢弃；`reengagementShadow` 走完 shouldStop + agent.compose
 * 但**不 deliver**，只记"本应发 X / 命中场景 Y / 停止原因 Z"。
 * 复聊 agent 当前不开放工具，shadow 再叠加"不投递"。
 */
@Injectable()
export class FollowUpProcessor implements OnModuleInit {
  private readonly logger = new Logger(FollowUpProcessor.name);

  constructor(
    @InjectQueue(REENGAGEMENT_QUEUE) private readonly queue: Queue<FollowUpJob>,
    private readonly session: SessionService,
    private readonly reengagementAgent: ReengagementAgent,
    private readonly touchLedger: TouchLedgerService,
    private readonly systemConfig: SystemConfigService,
    private readonly tracking: ReengagementTrackingService,
    private readonly messageTracking: MessageTrackingService,
    private readonly chatSession: ChatSessionService,
    private readonly messageProcessing: MessageProcessingService,
    private readonly sponge: SpongeService,
    private readonly longTerm: LongTermService,
    private readonly scheduler: FollowUpSchedulerService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(REENGAGEMENT_DELIVERY_PORT)
    private readonly delivery?: ReengagementDeliveryPort<TurnOutcome>,
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
    const channelIdentity = await this.resolveJobChannelIdentity(job.data);
    const identity: ReengagementTouchIdentity = {
      sessionId: sessionRef.sessionId,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      scenarioCode,
      anchorEventId,
      anchorAt,
      ...channelIdentity,
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
    const loadedState = await this.session.getAuthoritativeState(
      sessionRef.corpId,
      sessionRef.userId,
      sessionRef.sessionId,
    );
    let bookingContext: ReengagementBookingContext | undefined;
    if (scenario.anchorEvent === 'booking.succeeded') {
      if (job.data.workOrderId == null) {
        this.tracking.trackStopped(identity, 'missing_authoritative_work_order_id');
        return;
      }
      bookingContext =
        (await resolveReengagementBookingContext(this.longTerm, this.sponge, {
          corpId: sessionRef.corpId,
          userId: sessionRef.userId,
          preferredWorkOrderId: job.data.workOrderId,
          botImId: channelIdentity?.botImId,
        })) ?? undefined;

      // 面试排程解析任务只保存工单引用；拿到海绵实时工单后才创建正式 delayed job。
      // 查询失败抛错交给 Bull backoff 重试，绝不使用预约工具参数兜底。
      if (job.data.resolveBookingAtFire) {
        if (!bookingContext || !job.data.workOrderId) {
          throw new Error(
            `reengagement_booking_context_unavailable:${job.data.workOrderId ?? '-'}`,
          );
        }
        const invalidReason = this.checkBookingInvalidAtFire(bookingContext);
        if (invalidReason) {
          this.tracking.trackStopped(identity, invalidReason);
          return;
        }
        if (!bookingContext.interviewAt) {
          throw new Error(`reengagement_booking_time_unavailable:${job.data.workOrderId}`);
        }
        await this.scheduler.scheduleFollowUp({
          sessionRef,
          scenarioCode,
          anchorEventId: bookingFollowUpAnchorId(
            bookingContext.workOrderId,
            bookingContext.interviewAt,
            scenarioCode,
            bookingContext.interviewType,
          ),
          anchorAt: now,
          state: {
            ...loadedState,
            terminal: 'booked',
            interviewAt: bookingContext.interviewAt,
          } as AuthoritativeSessionState,
          workOrderId: bookingContext.workOrderId,
          expectedInterviewAt: bookingContext.interviewAt,
          interviewType: bookingContext.interviewType,
          channelIdentity,
        });
        return;
      }

      if (!bookingContext) {
        throw new Error(`reengagement_booking_context_unavailable:${job.data.workOrderId ?? '-'}`);
      }
      if (!bookingContext.interviewAt) {
        const invalidReason = this.checkBookingInvalidAtFire(bookingContext);
        if (invalidReason) {
          this.tracking.trackStopped(identity, invalidReason);
          return;
        }
        throw new Error(`reengagement_booking_time_unavailable:${job.data.workOrderId}`);
      }
    }

    const state = bookingContext?.interviewAt
      ? ({ ...loadedState, interviewAt: bookingContext.interviewAt } as AuthoritativeSessionState)
      : loadedState;

    // 1) 停止条件（代码，调 LLM 之前）
    const stop = shouldStop(scenario, state, anchorAt, {
      externallyVerifiable: job.data.workOrderId != null,
      now,
    });
    if (stop.stop) {
      this.logger.log(
        `[reengagement] 停止 ${scenarioCode} sessionId=${sessionRef.sessionId} 原因=${stop.reason}`,
      );
      this.tracking.trackStopped(identity, stop.reason ?? 'stopped');
      return;
    }

    // 1.3) 报名后真人介入闸：候选人在报名锚点后发过消息，随后真人经理又从企微
    // 客户端手打回复，说明本次面试已进入人工判断/跟进。真人拒面、手工约面、已人工
    // 回复都不会写 Agent terminal，也不一定及时同步到海绵工单；继续发面试提醒或
    // 回访会越过真人结论。只认带来源的真人手打文本，不把 API_SEND/AI_REPLY、
    // 入群卡片或复聊回灌当人工介入。
    //
    // 这道闸与 lastProcessedCandidateMessageAt 水位正交：候选人 timeout 后若无人
    // 回复，不会命中；只有后续确有真人回复才停，避免把 PR #766 修复的无人搭理回话
    // 重新算成“已回话”。
    if (scenario.phase === 'post_booking') {
      const humanReplyAt = await this.detectHumanInterventionAfterCandidate(
        sessionRef.sessionId,
        anchorAt,
        now,
      );
      if (humanReplyAt != null) {
        this.logger.log(
          `[reengagement] 真人介入闸命中，停止 ${scenarioCode} sessionId=${sessionRef.sessionId} ` +
            `humanReplyAt=${new Date(humanReplyAt).toISOString()}`,
        );
        this.tracking.trackStopped(identity, 'human_intervention_after_candidate');
        return;
      }
    }

    // 1.4) 候选人待答前置闸：候选人最后一条消息晚于我方最后一条消息，且从未进过
    // 处理管道（无对应 message_processing_record）时，说明该轮被静默丢弃、候选人
    // 还在等回复——任何主动触达都不该压在未答消息上面（badcase recvqz4yWbdIKm：
    // 候选人 7/24 自曝暑假工身份的三条消息被丢，7/27 面试提醒照发触怒候选人）。
    // 与"Agent 主动沉默"区分：主动沉默的轮次有处理记录，本闸不拦。
    // 命中即停止并落触达底账（reason=pending_candidate_message），该信号同时是
    // 主链丢消息的显性化探针，值得告警排查。
    const pendingCandidateMessageAt = await this.detectPendingCandidateMessage(
      sessionRef.sessionId,
      now,
    );
    if (pendingCandidateMessageAt != null) {
      this.logger.warn(
        `[reengagement] 候选人待答闸命中，停止 ${scenarioCode} sessionId=${sessionRef.sessionId} ` +
          `候选人最后消息 ${new Date(pendingCandidateMessageAt).toISOString()} 未被处理（疑似主链丢 turn）`,
      );
      this.tracking.trackStopped(identity, 'pending_candidate_message');
      return;
    }

    // 1.5) 报名后场景到点核验：向海绵查工单现状（外部取消/已面试）并按实时面试时间校准排程。
    // 查询或关键时间缺失会在上方抛错重试，严格 fail closed，不使用旧任务/记忆快照放行。
    if (scenario.anchorEvent === 'booking.succeeded' && bookingContext) {
      const invalidReason = this.checkBookingInvalidAtFire(bookingContext);
      if (invalidReason) {
        this.logger.log(
          `[reengagement] 停止 ${scenarioCode} sessionId=${sessionRef.sessionId} 原因=${invalidReason}`,
        );
        this.tracking.trackStopped(identity, invalidReason);
        return;
      }

      const expectedFireAt = computeFireAt(
        scenario,
        {
          anchorAt: now,
          state,
          interviewType: bookingContext.interviewType,
        },
        runtime.reengagementScenarioDelayMinutes?.[scenario.code],
      );
      if (expectedFireAt - now > BOOKING_SCHEDULE_TOLERANCE_MS) {
        await this.scheduleTimeChangedReplacement(
          job.data,
          state,
          bookingContext.interviewAt!,
          bookingContext,
        );
        this.tracking.trackStopped(identity, 'interview_time_changed');
        return;
      }
      if (scenarioCode === 'interview_reminder' && bookingContext.interviewAt! <= now) {
        this.tracking.trackStopped(identity, 'interview_time_passed');
        return;
      }
    }

    // 1.55) pre_booking 带外工单核验（human_oob 确定性切片，badcase recvqgvKqRAcKg 族）：
    // pre_booking 场景只认 Agent 自建 terminal 态，经理带外约面/拒面、候选人已面试的
    // 事实只在海绵工单里。到点按手机号查该候选人全部工单，在途/已推进即停。
    // 无手机号或查询失败按放行降级（该闸历史上不存在，fail open 仅维持现状，
    // 不让海绵抖动放大成全量复聊静默）。
    if (scenario.phase === 'pre_booking') {
      const oobVerdict = await this.checkOutOfBandWorkOrderAtFire(state, channelIdentity?.botImId);
      if (oobVerdict) {
        this.logger.log(
          `[reengagement] 停止 ${scenarioCode} sessionId=${sessionRef.sessionId} 原因=${oobVerdict.reason}` +
            `（带外工单 workOrderId=${oobVerdict.workOrderId ?? '-'}）`,
        );
        this.tracking.trackStopped(identity, oobVerdict.reason);
        return;
      }
    }

    // 1.6) 同 session 触达冷却：跨场景兜底互斥，避免候选人短时间内收到**连续无回应**
    // 追问。候选人在上次触达后已回话时冷却不适用（对话恢复过，本次锚点是新一段
    // 沉默）——否则开场唤醒会把 booking_incomplete 等深漏斗跟进一并压住
    // （badcase recvqD1PRROepW）。
    if (
      !scenario.sessionCooldownExempt &&
      (await this.touchLedger.isInSessionTouchCooldown(sessionRef.sessionId, now, {
        candidateRepliedAt: state.lastCandidateMessageAt ?? null,
      }))
    ) {
      this.logger.log(
        `[reengagement] 同会话触达冷却，丢弃 ${scenarioCode} sessionId=${sessionRef.sessionId}`,
      );
      this.tracking.trackStopped(identity, 'session_touch_cooldown');
      return;
    }

    // 2) 频控：24h ≤ 2（只数 sent）
    if (await this.touchLedger.isOverFrequencyLimit(sessionRef.sessionId, now)) {
      this.logger.log(`[reengagement] 频控丢弃 ${scenarioCode} sessionId=${sessionRef.sessionId}`);
      this.tracking.trackFrequencyBlocked(identity);
      return;
    }

    // 3) 投递 + 触达底账（shadow 只记不发）。真实发送前由统一投递层再次检查
    // 当前会话是否仍处于托管状态；已暂停/取消托管则整条跳过。
    // 无投递端口绑定时强制 shadow；否则读运行时配置（与开头的总开关同一次读取）。
    // 所有未投递分支都不把生成文本写进记忆（复聊链路不走 runner，本 processor 全程不投影助手轮次）：
    // 候选人没收到这条文本，若被投影成助手轮次，下一轮真实对话会引用一段候选人从未见过的"跟进"（HC-4 幽灵回复）。
    // 场景级灰度（Dashboard 可配）：场景开关 × 报名后大开关叠加
    const rolloutEnabled = resolveRolloutEnabled(scenario, runtime);
    const shadow = !this.delivery || runtime.reengagementShadow;
    if (shadow || !rolloutEnabled || !this.delivery) {
      const batchId = `batch_${sessionRef.sessionId}_${now}`;
      const execution = await this.runProactiveTurn(
        job.data,
        state,
        scenario,
        batchId,
        { rolloutEnabled, shadow },
        bookingContext,
      );
      const { outcome } = execution;
      this.logger.log(
        `[reengagement][SHADOW] 本应发: scenario=${scenarioCode} sessionId=${sessionRef.sessionId} ` +
          `text="${outcome.kind === 'reply' ? outcome.reply?.text.slice(0, 60) : `[${outcome.kind}]`}"` +
          `（shadow=${shadow}, rollout=${rolloutEnabled}）`,
      );
      this.tracking.trackShadow(identity, {
        outcomeKind: outcome.kind,
        generatedText:
          outcome.generatedText ?? (outcome.kind === 'reply' ? outcome.reply?.text : undefined),
        reason:
          execution.validationReason ??
          (!this.delivery
            ? 'no_delivery_port'
            : !rolloutEnabled
              ? 'rollout_disabled'
              : 'shadow_mode'),
        batchId,
      });
      this.messageTracking.recordProactiveTurn(
        this.buildProactiveTurnRecord({
          batchId,
          sessionRef,
          scenario,
          outcome,
          receivedAt: now,
          status: 'success',
          replyPreview:
            outcome.generatedText ?? (outcome.kind === 'reply' ? outcome.reply?.text : undefined),
          channelIdentity,
          execution,
          completedAt: Date.now(),
          deliveryResult: {
            success: true,
            segmentCount: 0,
            failedSegments: 0,
            deliveredSegments: 0,
            totalTime: 0,
          },
        }),
      );
      return;
    }

    // 与 Bull job / 追踪底账共用稳定锚点。anchorAt 可能在两个并发工单解析时落在同一
    // 毫秒，不能作为多面试场景的幂等身份，否则第二场提醒会被误判成重复触达。
    const key = ReengagementTrackingService.touchKey(identity);
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
    const execution = await this.runProactiveTurn(
      job.data,
      state,
      scenario,
      batchId,
      { rolloutEnabled, shadow },
      bookingContext,
    );
    const { outcome } = execution;
    if (outcome.kind !== 'reply' || !outcome.reply) {
      this.logger.log(
        `[reengagement] 回合非 reply（${outcome.kind}）→ 不投递 ${scenarioCode} sessionId=${sessionRef.sessionId}`,
      );
      this.tracking.trackOutcomeNotReply(
        identity,
        outcome.kind,
        batchId,
        execution.validationReason,
      );
      this.messageTracking.recordProactiveTurn(
        this.buildProactiveTurnRecord({
          batchId,
          sessionRef,
          scenario,
          outcome,
          receivedAt: now,
          status: 'success',
          replyPreview: `[未投递:${outcome.kind}]`,
          channelIdentity,
          execution,
          completedAt: Date.now(),
          deliveryResult: {
            success: true,
            segmentCount: 0,
            failedSegments: 0,
            deliveredSegments: 0,
            totalTime: 0,
          },
        }),
      );
      await this.touchLedger.markFailedOrUnknown(key, 'failed');
      return;
    }
    await this.outboxDeliverReserved(execution, key, sessionRef.sessionId, now, identity, batchId);
  }

  /**
   * 渠道身份：优先 job payload（排程时冻结）；存量任务（部署窗口前入队）payload 缺失时
   * 到点兜底查 chat_messages 最新快照（与 20260706160000 迁移回填同源）。不兜底则该
   * 触达行 candidate_name 恒为 NULL 且无法自愈——后续所有事件同样来自无身份的 job.data，
   * record_reengagement_touch 的 COALESCE 只认非空入参。兜底失败按空身份放行不阻断。
   */
  private async resolveJobChannelIdentity(
    jobData: FollowUpJob,
  ): Promise<FollowUpJob['channelIdentity']> {
    const fromJob = jobData.channelIdentity;
    if (
      fromJob &&
      (fromJob.candidateName ||
        fromJob.managerName ||
        fromJob.botImId ||
        fromJob.imContactId ||
        fromJob.externalUserId)
    ) {
      return fromJob;
    }
    try {
      const resolved = await this.tracking.resolveChannelIdentity(jobData.sessionRef.sessionId);
      if (resolved) return resolved;
    } catch (error) {
      this.logger.warn(
        `[reengagement] 渠道身份兜底查询失败，按空身份落库 sessionId=${jobData.sessionRef.sessionId}: ${this.errorMessage(error)}`,
      );
      return fromJob;
    }
    this.logger.warn(
      `[reengagement] 渠道身份兜底无结果，按空身份落库 sessionId=${jobData.sessionRef.sessionId}`,
    );
    return fromJob;
  }

  /**
   * 候选人待答检测（触达前置闸 1.4 的实现）。
   *
   * 判定条件（全部满足才算"待答"，返回候选人最后消息时间戳；否则 null）：
   * 1. 会话最后一条消息是候选人的（role=user；AI 回复与真人手打均落 role=assistant，
   *    任一方说了最后一句都不算待答）；
   * 2. 该消息已超过宽限期（避免把在途 debounce/处理中的轮次误判为丢失）；
   * 3. 该消息从未进入处理管道——chat 最近一条 message_processing_record 的
   *    received_at 早于该消息（留合并批次锚点容差）。**有处理记录即不拦**：
   *    Agent 主动沉默是合法出站结果，其轮次有记录。
   *
   * 历史/流水查询失败一律 fail open（返回 null 放行触达）——本闸是体验加固，
   * 不能因观测数据不可用把复聊整体憋死。
   */
  private async detectPendingCandidateMessage(
    sessionId: string,
    now: number,
  ): Promise<number | null> {
    const GRACE_MS = 10 * 60 * 1000;
    // received_at 是 debounce 合并批次的锚点，可能略早于批内最后一条消息的存储时间戳
    const MERGE_TOLERANCE_MS = 2 * 60 * 1000;
    try {
      const history = await this.chatSession.getChatHistory(sessionId, 10);
      if (history.length === 0) return null;
      const last = history[history.length - 1];
      if (last.role !== 'user') return null;
      const lastUserAt = last.timestamp;
      if (!Number.isFinite(lastUserAt)) return null;
      if (now - lastUserAt < GRACE_MS) return null;
      const latestProcessedAt = await this.messageProcessing.getLatestReceivedAtByChatId(sessionId);
      if (latestProcessedAt != null && latestProcessedAt >= lastUserAt - MERGE_TOLERANCE_MS) {
        return null;
      }
      return lastUserAt;
    } catch (error) {
      this.logger.warn(
        `[reengagement] 候选人待答检测失败，按放行处理 sessionId=${sessionId}: ${this.errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * 报名锚点后是否已形成「候选人消息 → 真人经理手打文本」的人工介入证据。
   *
   * 查询失败 fail open：聊天历史是辅助证据面，不能因观测存储抖动把报名后触达全量
   * 静默。最多读取 200 条锚点后消息，覆盖预约后到提醒/回访的短窗口。
   */
  private async detectHumanInterventionAfterCandidate(
    sessionId: string,
    anchorAt: number,
    now: number,
  ): Promise<number | null> {
    try {
      const history = await this.chatSession.getChatHistory(sessionId, 200, {
        startTimeInclusive: anchorAt,
        endTimeInclusive: now,
      });
      let candidateMessageSeen = false;
      for (const message of history) {
        if (message.role === 'user') {
          candidateMessageSeen = true;
          continue;
        }
        if (candidateMessageSeen && isHumanAgentTextMessage(message)) {
          return message.timestamp;
        }
      }
      return null;
    } catch (error) {
      this.logger.warn(
        `[reengagement] 真人介入检测失败，按放行处理 sessionId=${sessionId}: ${this.errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * pre_booking 带外工单核验：按候选人手机号查海绵全部工单，交给纯分类器判停。
   *
   * 手机号来源是权威状态的 collectedFields（booking 写回或候选人自陈）；拿不到
   * 手机号说明该候选人极大概率没走过任何报名流程，跳过核验不算漏。
   * 查询失败 fail open：pre_booking 历史上没有这道闸，降级即维持现状行为。
   */
  private async checkOutOfBandWorkOrderAtFire(
    state: AuthoritativeSessionState,
    botImId?: string,
  ): Promise<OutOfBandWorkOrderVerdict | null> {
    const phone = state.collectedFields?.phone?.value?.trim();
    if (!phone || !/^1\d{10}$/.test(phone)) return null;
    try {
      const result = await this.sponge.fetchSignupWorkOrders(
        { phone },
        botImId ? { botImId } : undefined,
      );
      return evaluateOutOfBandWorkOrders(result.workOrders ?? [], Date.now());
    } catch (error) {
      this.logger.warn(
        `[reengagement] 带外工单核验失败（fail open 放行）: ${this.errorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * 报名后场景到点核验（shouldStop 之后、生成之前）。返回失效原因；仍有效返回 null。
   *
   * - 海绵实时工单现状（source of truth）：只有约面待确认/约面成功是进行中报名；
   *   取消、失败、面试结果已出及上岗后状态均停止提醒和回访。
   * - 工单或面试时间拿不到时，上游直接抛错重试并 fail closed，不允许旧快照兜底发送。
   */
  private checkBookingInvalidAtFire(bookingContext: ReengagementBookingContext): string | null {
    const currentStatus = bookingContext.currentStatus ?? null;
    if (!currentStatus) return 'work_order_status_unavailable';
    return ACTIVE_INTERVIEW_WORK_ORDER_STATUSES.has(currentStatus)
      ? null
      : `work_order_not_active:${currentStatus}`;
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
    bookingContext: ReengagementBookingContext,
  ): Promise<void> {
    const { sessionRef, scenarioCode, workOrderId } = jobData;
    if (workOrderId == null) return;
    if (scenarioCode === 'interview_reminder' && newInterviewAt <= Date.now()) return;
    try {
      await this.scheduler.scheduleFollowUp({
        sessionRef,
        scenarioCode,
        anchorEventId: bookingFollowUpAnchorId(
          workOrderId,
          newInterviewAt,
          scenarioCode,
          bookingContext.interviewType,
        ),
        // 保留原报名锚点。替代任务仅因工单面试时间变化而重排；若改成当前时间，
        // Agent 状态摘要会把重排时间误标为“报名完成时间”，也会改变候选人回复停止边界。
        anchorAt: jobData.anchorAt,
        state: {
          ...state,
          terminal: 'booked',
          interviewAt: newInterviewAt,
        } as AuthoritativeSessionState,
        workOrderId,
        expectedInterviewAt: newInterviewAt,
        interviewType: bookingContext.interviewType,
        channelIdentity: jobData.channelIdentity,
      });
    } catch (error) {
      this.logger.warn(
        `[reengagement] 改期替代任务排程失败 workOrderId=${workOrderId} scenario=${scenarioCode}: ${this.errorMessage(error)}`,
      );
    }
  }

  private async runProactiveTurn(
    jobData: FollowUpJob,
    state: AuthoritativeSessionState,
    scenario: NonNullable<ReturnType<typeof getScenario>>,
    messageId?: string,
    options?: { rolloutEnabled?: boolean; shadow?: boolean },
    bookingContext?: ReengagementBookingContext,
  ): Promise<ProactiveTurnExecution> {
    const result = await this.reengagementAgent.compose({
      sessionRef: jobData.sessionRef,
      scenario,
      jobData,
      state,
      messageId,
      rolloutEnabled: options?.rolloutEnabled,
      shadow: options?.shadow,
      bookingContext,
    });
    if ((result as ProactiveTurnExecution).outcome) return result;
    return {
      outcome: result as unknown as TurnOutcome,
      aiStartAt: Date.now(),
      aiEndAt: Date.now(),
    };
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
    execution: ProactiveTurnExecution;
    completedAt: number;
    deliveryResult?: ProactiveDeliveryResult;
  }): MessageProcessingRecordInput {
    const { batchId, sessionRef, scenario, execution } = params;
    const { outcome } = execution;
    const replyText = outcome.reply?.text ?? outcome.generatedText;
    const aiDuration = Math.max(execution.aiEndAt - execution.aiStartAt, 0);
    const totalDuration = Math.max(params.completedAt - params.receivedAt, 0);
    const deliveryStartAt = params.deliveryResult ? execution.aiEndAt : undefined;
    const deliveryEndAt = params.deliveryResult ? params.completedAt : undefined;
    const deliveryDuration =
      params.deliveryResult?.totalTime ??
      (deliveryStartAt !== undefined
        ? Math.max(params.completedAt - deliveryStartAt, 0)
        : undefined);
    const agentInvocation = {
      request: {
        traceId: batchId,
        messageId: batchId,
        chatId: sessionRef.sessionId,
        userId: sessionRef.userId,
        userName: params.channelIdentity?.candidateName,
        managerName: params.channelIdentity?.managerName,
        imBotId: params.channelIdentity?.botImId,
        scenario: `reengagement:${scenario.code}`,
        content: `[系统主动跟进:${scenario.code}]`,
        proactiveDirective: `${scenario.objective}。生成要求：${scenario.generationPolicy}`,
        dispatchMode: 'proactive',
        batchId,
        acceptedAt: params.receivedAt,
        sourceMessageIds: [],
        sourceMessageCount: 0,
        imageCount: 0,
        agentRequest: execution.agentRequest,
      },
      response: {
        status: params.status,
        error: params.error,
        reply: {
          content: replyText,
          reasoning: outcome.reasoning,
          usage: outcome.usage,
        },
        messages: outcome.responseMessages,
        toolCalls: outcome.toolCalls,
        delivery: params.deliveryResult,
        timings: {
          timestamps: {
            acceptedAt: params.receivedAt,
            workerStartAt: params.receivedAt,
            aiStartAt: execution.aiStartAt,
            aiEndAt: execution.aiEndAt,
            deliveryStartAt,
            firstSegmentSentAt: replyText ? deliveryEndAt : undefined,
            deliveryEndAt,
            completedAt: params.completedAt,
          },
          durations: {
            acceptedToWorkerStartMs: 0,
            quietWindowWaitMs: 0,
            queueWaitMs: 0,
            prepMs: Math.max(execution.aiStartAt - params.receivedAt, 0),
            queueMs: 0,
            workerStartToAiStartMs: Math.max(execution.aiStartAt - params.receivedAt, 0),
            aiStartToAiEndMs: aiDuration,
            acceptedToAiStartMs: Math.max(execution.aiStartAt - params.receivedAt, 0),
            acceptedToAiEndMs: Math.max(execution.aiEndAt - params.receivedAt, 0),
            acceptedToFirstSegmentSentMs:
              deliveryEndAt !== undefined
                ? Math.max(deliveryEndAt - params.receivedAt, 0)
                : undefined,
            acceptedToDeliveryStartMs:
              deliveryStartAt !== undefined
                ? Math.max(deliveryStartAt - params.receivedAt, 0)
                : undefined,
            acceptedToDeliveryEndMs:
              deliveryEndAt !== undefined
                ? Math.max(deliveryEndAt - params.receivedAt, 0)
                : undefined,
            aiEndToDeliveryStartMs:
              deliveryStartAt !== undefined
                ? Math.max(deliveryStartAt - execution.aiEndAt, 0)
                : undefined,
            requestToFirstTextDeltaMs: Math.max(execution.aiEndAt - params.receivedAt, 0),
            deliveryDurationMs: deliveryDuration,
            totalMs: totalDuration,
          },
        },
      },
      isFallback: false,
    };
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
      totalDuration,
      queueDuration: 0,
      prepDuration: Math.max(execution.aiStartAt - params.receivedAt, 0),
      aiStartAt: execution.aiStartAt,
      aiEndAt: execution.aiEndAt,
      aiDuration,
      ttftMs: Math.max(execution.aiEndAt - params.receivedAt, 0),
      sendDuration: deliveryDuration,
      toolCalls: outcome.toolCalls,
      agentSteps: outcome.agentSteps,
      memorySnapshot: outcome.memorySnapshot,
      guardrailOutput: outcome.guardrailTrace,
      tokenUsage: outcome.usage?.totalTokens,
      isFallback: false,
      fallbackSuccess: false,
      agentInvocation,
    };
  }

  /** outbox 状态机投递：reserved → attempted → sent / unknown。 */
  private async outboxDeliverReserved(
    execution: ProactiveTurnExecution,
    key: string,
    sessionId: string,
    now: number,
    identity: ReengagementTouchIdentity,
    batchId: string,
  ): Promise<void> {
    const { outcome } = execution;
    const sessionRef = { sessionId, userId: identity.userId ?? '', corpId: identity.corpId ?? '' };
    const scenario = getScenario(identity.scenarioCode as FollowUpJob['scenarioCode']);
    const channelIdentity: FollowUpJob['channelIdentity'] = {
      candidateName: identity.candidateName,
      managerName: identity.managerName,
      botImId: identity.botImId,
      imContactId: identity.imContactId,
      externalUserId: identity.externalUserId,
    };
    let deliveryStartAt = 0;
    try {
      await this.touchLedger.markDeliveryAttempted(key);
      this.tracking.trackDeliveryAttempted(identity);
      deliveryStartAt = Date.now();
      const deliveryResult = (await this.delivery!.deliver(outcome, {
        idempotencyKey: key,
        context: this.buildDeliveryContext(identity, sessionId, batchId),
      })) as ProactiveDeliveryResult;
      const deliveryEndAt = Date.now();
      const deliveredSegments = deliveryResult.deliveredSegments ?? deliveryResult.segmentCount;
      if (deliveryResult.skipped || deliveredSegments <= 0) {
        const reason = deliveryResult.skipReason
          ? `delivery_skipped:${deliveryResult.skipReason}`
          : 'delivery_skipped';
        this.tracking.trackOutcomeNotReply(identity, 'delivery_skipped', batchId, reason);
        await this.touchLedger.markFailedOrUnknown(key, 'failed');
        if (scenario) {
          this.messageTracking.recordProactiveTurn(
            this.buildProactiveTurnRecord({
              batchId,
              sessionRef,
              scenario,
              outcome,
              receivedAt: now,
              status: 'success',
              replyPreview: `[未投递:${reason}]`,
              channelIdentity,
              execution,
              completedAt: deliveryEndAt,
              deliveryResult,
            }),
          );
        }
        return;
      }
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
            execution,
            completedAt: deliveryEndAt,
            deliveryResult: {
              ...deliveryResult,
              totalTime: deliveryResult.totalTime ?? Math.max(deliveryEndAt - deliveryStartAt, 0),
            },
          }),
        );
      }
    } catch (error) {
      const deliveryEndAt = Date.now();
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
            execution,
            completedAt: deliveryEndAt,
            deliveryResult: {
              success: false,
              segmentCount: 1,
              failedSegments: 1,
              deliveredSegments: 0,
              totalTime: deliveryStartAt > 0 ? Math.max(deliveryEndAt - deliveryStartAt, 0) : 0,
              error: this.errorMessage(error),
            },
          }),
        );
      }
      // 投递状态不明时不写助手历史：候选人可能没看到这条复聊。
      await this.touchLedger.markFailedOrUnknown(key, 'unknown');
      throw error;
    }
    this.logger.log(`[reengagement] 已投递 key=${key}`);
  }

  private buildDeliveryContext(
    identity: ReengagementTouchIdentity,
    sessionId: string,
    batchId: string,
  ): DeliveryContext {
    const token = this.resolveDeliveryToken(identity);
    return {
      token,
      imBotId: identity.botImId ?? '',
      imContactId: identity.imContactId ?? identity.externalUserId ?? '',
      imRoomId: '',
      contactName: identity.candidateName || '客户',
      messageId: batchId,
      chatId: sessionId,
      externalRequestId: batchId,
      _apiType: 'enterprise',
    };
  }

  /**
   * 投递 token 到点解析。⚠️ 这里要的是托管平台（Stride）发消息凭证，不是海绵 API token。
   * 复聊只发候选人私聊，统一使用企业级 `STRIDE_ENTERPRISE_TOKEN`。
   */
  private resolveDeliveryToken(identity: ReengagementTouchIdentity): string {
    const enterpriseToken = this.configService.get<string>('STRIDE_ENTERPRISE_TOKEN')?.trim() || '';
    if (!enterpriseToken) {
      this.logger.warn(
        `[reengagement] 投递 token 缺失（STRIDE_ENTERPRISE_TOKEN 未配置）botImId=${identity.botImId ?? '-'}`,
      );
    }
    return enterpriseToken;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
