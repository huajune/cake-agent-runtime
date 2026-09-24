import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import { isUserProfileFactValue } from '@memory/long-term/long-term.types';
import type { ReengagementSessionState } from '@memory/recall.types';
import { PhoneSessionIndexService } from '@memory/phone-session-index.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import type { BookingSnapshotEntry } from '@tools/booking/booking-snapshot.types';
import {
  buildReconcileAnchorKey,
  snapshotInterviewAt,
  snapshotSignUpAt,
} from '@tools/booking/booking-snapshot.util';
import {
  FollowUpSchedulerService,
  isInterviewSlotCheckStale,
  type ReengagementChannelIdentity,
} from './follow-up-scheduler.service';

export type OobReconcileTrigger = 'turn' | 'scan' | 'resume';

export interface OobReconcileInput {
  corpId: string;
  userId: string;
  chatId: string;
  botImId: string | null | undefined;
  /** 长期档案定位键；缺省时只用会话事实取姓名/手机号。 */
  botUserId?: string | null;
  /** 已知本人手机号（补偿扫描从索引带来）；缺省从会话事实/长期档案解析。 */
  phone?: string | null;
  traceId?: string;
  channelIdentity?: ReengagementChannelIdentity;
  trigger: OobReconcileTrigger;
  /**
   * 本轮已有成功的报名工具调用（渠道层按工具结果判定）：回合触发时禁止走清终态分支——
   * 新单可能还没进快照缓存，按「快照为空」清掉锚点链刚写的 booked 会让带活面试的会话被报名前场景骚扰。
   */
  bookingSucceededThisTurn?: boolean;
  /** 本次对账允许新排的等通知复核数上限（补偿扫描单轮总量控制）；缺省不限。 */
  maxSlotChecks?: number;
}

export interface OobReconcileResult {
  status: 'done' | 'skipped';
  reason?: string;
  supplierOwned: number;
  scheduled: number;
  linkedEvents: number;
  /** 本次新排的等通知满 3 天复核数（补偿扫描按此累计单轮上限）。 */
  slotChecksScheduled: number;
  terminal?: 'booked' | 'cleared' | 'unchanged';
}

/** 排过提醒的稳定锚点标记（非工单副本，只记"排没排过"）。 */
const ANCHOR_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 「booked 终态是本对账链路写的」标记：只有它在，快照为空时才允许回退终态。 */
const OOB_BOOKED_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_REMINDER_LEAD_MINUTES = 60;
const MINUTE_MS = 60 * 1000;

/**
 * 带外工单对账副作用（PRD R2）：判定带外、本人校验、会话终态、排面试提醒/回访、落独立事件。
 *
 * 只读快照、不落工单副本：蛋糕侧只留两样状态——提醒排没排过（稳定锚点标记）、带外事件发没发过
 * （ops_events 幂等键=工单号）。调用方三处：企微生产回合（渠道层异步）、补偿扫描、手动恢复托管。
 * 回归测试/调试链路不调用（它们也走 prepare 且连生产海绵）。
 */
@Injectable()
export class OobReconcileService implements OnModuleInit {
  private readonly logger = new Logger(OobReconcileService.name);

  constructor(
    private readonly bookingSnapshot: BookingSnapshotService,
    private readonly session: SessionStateService,
    private readonly longTerm: LongTermService,
    private readonly scheduler: FollowUpSchedulerService,
    private readonly opsEvents: OpsEventsRecorderService,
    private readonly redis: RedisService,
    private readonly systemConfig: SystemConfigService,
    @Optional() private readonly userHosting?: UserHostingService,
    @Optional() private readonly phoneSessionIndex?: PhoneSessionIndexService,
  ) {}

  /** 手动恢复托管即时对账一次（到期恢复不经过恢复函数，由下一回合与补偿扫描兜底）。 */
  onModuleInit(): void {
    this.userHosting?.registerResumeListener(async (chatId) => {
      await this.reconcileAfterResume(chatId);
    });
  }

  async reconcileAfterResume(chatId: string): Promise<OobReconcileResult | null> {
    try {
      const record = await this.phoneSessionIndex?.lookupByChat(chatId);
      if (!record) {
        this.logger.log(`[oob] 恢复托管对账跳过：无手机号→会话索引 chatId=${chatId}`);
        return null;
      }
      return await this.reconcile({
        corpId: record.corpId,
        userId: record.userId,
        chatId: record.chatId,
        botImId: record.botImId ?? null,
        phone: record.phone,
        trigger: 'resume',
      });
    } catch (error) {
      this.logger.warn(`[oob] 恢复托管对账失败 chatId=${chatId}: ${toErrorMessage(error)}`);
      return null;
    }
  }

  /** 渠道层 fire-and-forget 入口：任何失败只记日志，绝不影响回复投递。 */
  async reconcileAfterTurn(input: Omit<OobReconcileInput, 'trigger'>): Promise<void> {
    try {
      await this.reconcile({ ...input, trigger: 'turn' });
    } catch (error) {
      this.logger.warn(`[oob] 回合后对账失败 chatId=${input.chatId}: ${toErrorMessage(error)}`);
    }
  }

  async reconcile(input: OobReconcileInput): Promise<OobReconcileResult> {
    const empty: OobReconcileResult = {
      status: 'skipped',
      supplierOwned: 0,
      scheduled: 0,
      linkedEvents: 0,
      slotChecksScheduled: 0,
    };
    const identity = await this.resolveIdentity(input);
    if (!identity.phone) return { ...empty, reason: 'no_phone' };

    const snapshot = await this.bookingSnapshot.load({
      phone: identity.phone,
      botImId: input.botImId,
      corpId: input.corpId,
      userId: input.userId,
      knownCandidateNames: identity.names,
      // 回合内 prepare 刚查过（缓存命中即可）；扫描/恢复没有前置查询，必须穿透。
      bypassCache: input.trigger !== 'turn',
    });
    if (snapshot.status !== 'ok') return { ...empty, reason: snapshot.status };

    const now = Date.now();
    const ownedSupplier = snapshot.entries.filter(
      (entry) => entry.signupSource === 'SUPPLIER' && entry.ownedByCandidate,
    );
    const terminal = await this.reconcileTerminal(
      input,
      identity.phone,
      snapshot.entries,
      ownedSupplier,
    );

    let scheduled = 0;
    let linkedEvents = 0;
    const counters = { slotChecks: 0 };
    for (const entry of ownedSupplier) {
      linkedEvents += (await this.recordLinkedEvent(input, entry)) ? 1 : 0;
      scheduled += await this.scheduleFollowUps(input, entry, now, counters);
      if (input.trigger === 'resume') {
        scheduled += await this.rescheduleAfterResume(input, entry, now);
      }
    }
    if (ownedSupplier.length > 0 || terminal !== 'unchanged') {
      this.logger.log(
        `[oob] 对账完成 trigger=${input.trigger} chatId=${input.chatId} supplierOwned=${ownedSupplier.length} scheduled=${scheduled} slotChecks=${counters.slotChecks} linked=${linkedEvents} terminal=${terminal}`,
      );
    }
    return {
      status: 'done',
      supplierOwned: ownedSupplier.length,
      scheduled,
      linkedEvents,
      slotChecksScheduled: counters.slotChecks,
      terminal,
    };
  }

  private async resolveIdentity(
    input: OobReconcileInput,
  ): Promise<{ phone: string | null; names: string[] }> {
    const names: string[] = [];
    let phone = input.phone?.trim() ?? '';
    try {
      const state = await this.session.getSessionState(input.corpId, input.userId, input.chatId);
      const sessionName = state.facts?.interview_info?.name?.value;
      if (typeof sessionName === 'string' && sessionName.trim()) names.push(sessionName.trim());
      const sessionPhone = state.facts?.interview_info?.phone?.value;
      if (!phone && typeof sessionPhone === 'string') phone = sessionPhone.trim();
    } catch (error) {
      this.logger.warn(`[oob] 读取会话事实失败 chatId=${input.chatId}: ${toErrorMessage(error)}`);
    }
    const botUserId = input.botUserId?.trim();
    if (botUserId) {
      const profile = await this.longTerm.getProfile(input.corpId, input.userId, botUserId);
      const profileName = profile?.name;
      if (isUserProfileFactValue<string>(profileName) && profileName.value?.trim()) {
        names.push(profileName.value.trim());
      }
      const profilePhone = profile?.phone;
      if (!phone && isUserProfileFactValue<string>(profilePhone) && profilePhone.value) {
        phone = profilePhone.value.trim();
      }
    }
    return { phone: isStorableCandidatePhone(phone) ? phone : null, names };
  }

  /**
   * 会话终态：有本人带外在途工单 → booked（停报名前复聊），同时打「本链路写过 booked」标记；
   * 快照里已无任何在途工单且当前为 booked → 只有满足三件事才回退：标记在（booked 是本链路写的，
   * 不是 AI 自建单的锚点链写的）、本轮不是刚报名成功的回合、按手机号不带状态过滤再查一次海绵
   * 确认名下没有任何在途/待结果工单。任一不满足都不动——AI 自建的老单（报名超 15 天且面试已过）
   * 会从快照消失但仍在 booked，误清会让带活报名的会话被报名前场景骚扰。其它终态（handed_off 等）不动。
   */
  private async reconcileTerminal(
    input: OobReconcileInput,
    phone: string,
    entries: readonly BookingSnapshotEntry[],
    ownedSupplier: readonly BookingSnapshotEntry[],
  ): Promise<'booked' | 'cleared' | 'unchanged'> {
    try {
      const state = await this.session.getReengagementState(
        input.corpId,
        input.userId,
        input.chatId,
      );
      if (ownedSupplier.length > 0 && state.terminal == null) {
        await this.session.saveTerminalState(input.corpId, input.userId, input.chatId, 'booked');
        await this.markOobBooked(input.chatId);
        return 'booked';
      }
      if (entries.length === 0 && state.terminal === 'booked') {
        if (input.trigger === 'turn' && input.bookingSucceededThisTurn) return 'unchanged';
        if (!(await this.isOobBooked(input.chatId))) return 'unchanged';
        const hasOpen = await this.bookingSnapshot.hasOpenWorkOrders({
          phone,
          botImId: input.botImId,
        });
        // null = 查不到（无 token / 海绵失败 / 熔断），按未知不动；true = 名下还有在途/待结果单。
        if (hasOpen !== false) return 'unchanged';
        await this.session.saveTerminalState(input.corpId, input.userId, input.chatId, undefined);
        await this.clearOobBookedMarker(input.chatId);
        return 'cleared';
      }
    } catch (error) {
      this.logger.warn(`[oob] 会话终态对账失败 chatId=${input.chatId}: ${toErrorMessage(error)}`);
    }
    return 'unchanged';
  }

  /** 标记写失败只记日志：没有标记 = 永远不清，宁可多停报名前复聊也不误清。 */
  private async markOobBooked(chatId: string): Promise<void> {
    try {
      await this.redis.setex(oobBookedMarkerKey(chatId), OOB_BOOKED_MARKER_TTL_SECONDS, Date.now());
    } catch (error) {
      this.logger.warn(`[oob] booked 标记写入失败 chatId=${chatId}: ${toErrorMessage(error)}`);
    }
  }

  /** 读失败按「未标记」处理（fail-closed：不清终态）。 */
  private async isOobBooked(chatId: string): Promise<boolean> {
    try {
      return (await this.redis.get<number>(oobBookedMarkerKey(chatId))) != null;
    } catch (error) {
      this.logger.warn(`[oob] booked 标记读取失败 chatId=${chatId}: ${toErrorMessage(error)}`);
      return false;
    }
  }

  private async clearOobBookedMarker(chatId: string): Promise<void> {
    try {
      await this.redis.del(oobBookedMarkerKey(chatId));
    } catch (error) {
      this.logger.warn(`[oob] booked 标记删除失败 chatId=${chatId}: ${toErrorMessage(error)}`);
    }
  }

  private async recordLinkedEvent(
    input: OobReconcileInput,
    entry: BookingSnapshotEntry,
  ): Promise<boolean> {
    try {
      const signUpAt = snapshotSignUpAt(entry);
      return await this.opsEvents.recordEvent({
        corpId: input.corpId,
        eventName: 'booking.linked_out_of_band',
        idempotencyKey: `${entry.workOrderId}:oob_linked`,
        occurredAt: signUpAt != null ? new Date(signUpAt) : new Date(),
        botImId: input.botImId ?? null,
        userId: input.userId,
        chatId: input.chatId,
        payload: {
          source: 'oob',
          signup_source: entry.signupSource,
          work_order_id: entry.workOrderId,
          job_id: entry.jobId,
          brand_name: entry.brandName,
          job_name: entry.jobName,
          interview_time: entry.interviewTime,
          sign_up_time: entry.signUpTime,
          candidate_name: entry.candidateName,
          operation_logs: (entry.workOrder.operationLogs ?? []).map((log) => ({
            time: log.operationTime ?? null,
            type: log.operationType ?? null,
            name: log.operationName ?? null,
          })),
          trigger: input.trigger,
          trace_id: input.traceId ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        `[oob] booking.linked_out_of_band 落库失败 workOrderId=${entry.workOrderId}: ${toErrorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * 排面试提醒与面试后回访：稳定锚点 `reconcile:wo{工单号}:iv{面试时间}`——首次发现排一次；
   * 快照面试时间变化（含由空变有值）即换锚点重排；面试已过不排；无面试时间直接落
   * missing_interview_time（不调解析任务），并挂满 3 天复核。「报名完成时间」取海绵报名时间。
   *
   * 等通知单的复核受两道闸：报名已超 3 天 + 24 小时宽限的历史单不补排（scheduler 记
   * slot_check_skipped_stale，其余照排）；本次调用的复核配额用完时整条不占锚点、留给下一轮。
   */
  private async scheduleFollowUps(
    input: OobReconcileInput,
    entry: BookingSnapshotEntry,
    now: number,
    counters: { slotChecks: number },
  ): Promise<number> {
    const interviewAt = snapshotInterviewAt(entry);
    if (interviewAt != null && interviewAt <= now) return 0;
    const anchorAt = snapshotSignUpAt(entry) ?? now;
    const wantsSlotCheck = interviewAt == null && !isInterviewSlotCheckStale(anchorAt, now);
    if (
      wantsSlotCheck &&
      input.maxSlotChecks != null &&
      counters.slotChecks >= input.maxSlotChecks
    ) {
      this.logger.log(
        `[oob] 等通知复核配额已用完，本轮不占锚点 chatId=${input.chatId} workOrderId=${entry.workOrderId}`,
      );
      return 0;
    }
    const anchorKey = buildReconcileAnchorKey(entry);
    if (!(await this.claimAnchor(input.chatId, anchorKey))) return 0;

    const sessionRef = { corpId: input.corpId, userId: input.userId, sessionId: input.chatId };
    let scheduled = 0;
    if (interviewAt == null) {
      const state = {
        collectedFields: {},
        recalledJobIds: new Set<number>(),
        hardConstraints: [],
        presentedStores: [],
        stage: null,
        terminal: 'booked',
        interviewAt: undefined,
      } as ReengagementSessionState;
      await this.scheduler.scheduleFollowUp({
        sessionRef,
        scenarioCode: 'interview_reminder',
        anchorEventId: `${anchorKey}:interview_reminder`,
        anchorAt,
        state,
        workOrderId: entry.workOrderId,
        channelIdentity: input.channelIdentity,
      });
      const slotCheck = await this.scheduler.scheduleInterviewSlotCheck({
        sessionRef,
        workOrderId: entry.workOrderId,
        signUpAt: anchorAt,
        channelIdentity: input.channelIdentity,
      });
      if (slotCheck.scheduled) counters.slotChecks += 1;
      return 0;
    }
    for (const scenarioCode of ['interview_reminder', 'post_interview_followup'] as const) {
      const result = await this.scheduler.scheduleBookingResolution({
        sessionRef,
        scenarioCode,
        workOrderId: entry.workOrderId,
        anchorEventId: `${anchorKey}:${scenarioCode}`,
        anchorAt,
        channelIdentity: input.channelIdentity,
      });
      if (result.scheduled) scheduled += 1;
    }
    return scheduled;
  }

  /**
   * 手动恢复托管后：暂停期间被跳过的提醒用 `:resumed` 后缀重排（同锚点的已完成任务在保留期内
   * 会被直接判重），且只在距面试不少于配置提前量时重排。
   */
  private async rescheduleAfterResume(
    input: OobReconcileInput,
    entry: BookingSnapshotEntry,
    now: number,
  ): Promise<number> {
    const interviewAt = snapshotInterviewAt(entry);
    if (interviewAt == null || interviewAt <= now) return 0;
    const baseKey = buildReconcileAnchorKey(entry);
    const baseClaimed = await this.isAnchorClaimed(input.chatId, baseKey);
    // 首次发现（基础锚点本轮刚排）无需重排。
    if (!baseClaimed || baseClaimed === 'fresh') return 0;
    const leadMs = (await this.resolveReminderLeadMinutes()) * MINUTE_MS;
    if (interviewAt - now < leadMs) return 0;
    const resumedKey = buildReconcileAnchorKey(entry, 'resumed');
    if (!(await this.claimAnchor(input.chatId, resumedKey))) return 0;
    const sessionRef = { corpId: input.corpId, userId: input.userId, sessionId: input.chatId };
    let scheduled = 0;
    for (const scenarioCode of ['interview_reminder', 'post_interview_followup'] as const) {
      const result = await this.scheduler.scheduleBookingResolution({
        sessionRef,
        scenarioCode,
        workOrderId: entry.workOrderId,
        anchorEventId: `${resumedKey}:${scenarioCode}`,
        anchorAt: now,
        channelIdentity: input.channelIdentity,
      });
      if (result.scheduled) scheduled += 1;
    }
    return scheduled;
  }

  private async resolveReminderLeadMinutes(): Promise<number> {
    try {
      const runtime = await this.systemConfig.getAgentReplyConfig();
      const configured = runtime.reengagementScenarioDelayMinutes?.interview_reminder;
      return typeof configured === 'number' && configured > 0
        ? configured
        : DEFAULT_REMINDER_LEAD_MINUTES;
    } catch {
      return DEFAULT_REMINDER_LEAD_MINUTES;
    }
  }

  /** 稳定锚点标记：SET NX；首次占到返回 true。Redis 故障按"已排过"处理，宁可漏排不重复骚扰。 */
  private async claimAnchor(chatId: string, anchorKey: string): Promise<boolean> {
    try {
      return await this.redis.setNx(
        anchorMarkerKey(chatId, anchorKey),
        Date.now(),
        ANCHOR_MARKER_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(`[oob] 锚点标记写入失败 ${anchorKey}: ${toErrorMessage(error)}`);
      return false;
    }
  }

  private async isAnchorClaimed(
    chatId: string,
    anchorKey: string,
  ): Promise<'fresh' | 'old' | null> {
    try {
      const claimedAt = await this.redis.get<number>(anchorMarkerKey(chatId, anchorKey));
      if (claimedAt == null) return null;
      return Date.now() - Number(claimedAt) < 60 * 1000 ? 'fresh' : 'old';
    } catch {
      return null;
    }
  }
}

function anchorMarkerKey(chatId: string, anchorKey: string): string {
  return `oob:anchor:${chatId}:${anchorKey}`;
}

function oobBookedMarkerKey(chatId: string): string {
  return `oob:booked:${chatId}`;
}
