import { Injectable, Logger } from '@nestjs/common';
import {
  RecordReengagementTouchInput,
  ReengagementTouchEventName,
  ReengagementTouchStatus,
} from '../../entities/reengagement-touch.entity';
import { ReengagementTouchRepository } from '../../repositories/reengagement-touch.repository';

/** 触达身份（写入侧各埋点共用）。昵称/bot 为渠道身份快照，随记录冗余落库，查询免关联。 */
export interface ReengagementTouchIdentity {
  sessionId: string;
  userId?: string;
  corpId?: string;
  scenarioCode: string;
  anchorEventId: string;
  anchorAt: number;
  /** 候选人微信昵称（排程时冻结，存量任务可能缺失） */
  candidateName?: string;
  /** 接管 bot 显示名 */
  managerName?: string;
  /** 接管 bot 系统 wxid */
  botImId?: string;
}

/**
 * 二次触发全生命周期落库（纯观测，不参与运行时决策）
 *
 * 所有方法 fire-and-forget：内部吞异常只告警，绝不阻塞排程/投递主流程。
 * touch_key = sessionId:scenarioCode:anchorEventId（与排程 Bull jobId 一致），
 * 同一次触达的多次流转落到同一行，events 数组保留全轨迹。
 *
 * Redis 触达底账（TouchLedgerService）仍负责在线频控与 outbox 幂等，职责不变。
 */
@Injectable()
export class ReengagementTrackingService {
  private readonly logger = new Logger(ReengagementTrackingService.name);

  constructor(private readonly repository: ReengagementTouchRepository) {}

  static touchKey(
    identity: Pick<ReengagementTouchIdentity, 'sessionId' | 'scenarioCode' | 'anchorEventId'>,
  ): string {
    return `${identity.sessionId}:${identity.scenarioCode}:${identity.anchorEventId}`;
  }

  /** 排程成功入队 */
  trackScheduled(identity: ReengagementTouchIdentity, jobId: string, fireAt: number): void {
    this.persist({
      ...this.base(identity),
      jobId,
      status: ReengagementTouchStatus.Scheduled,
      fireAt,
      scheduledAt: Date.now(),
      event: { event: ReengagementTouchEventName.Scheduled, detail: { jobId, fireAt } },
    });
  }

  /** 排程前预检停止（未入队） */
  trackScheduleSkipped(identity: ReengagementTouchIdentity, reason: string): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Skipped,
      decisionReason: reason,
      scheduledAt: Date.now(),
      event: { event: ReengagementTouchEventName.SchedulePrecheckStopped, detail: { reason } },
    });
  }

  /** 入队失败 */
  trackScheduleError(identity: ReengagementTouchIdentity, error: string): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Failed,
      decisionReason: ReengagementTouchEventName.EnqueueError,
      error,
      event: { event: ReengagementTouchEventName.EnqueueError, detail: { error } },
    });
  }

  /** 到点时总开关关闭，任务丢弃 */
  trackDisabledAtFire(identity: ReengagementTouchIdentity): void {
    this.markFired(
      identity,
      ReengagementTouchStatus.Disabled,
      'reengagement_disabled',
      ReengagementTouchEventName.FiredButDisabled,
    );
  }

  /** 到点停止条件命中 */
  trackStopped(identity: ReengagementTouchIdentity, reason: string): void {
    this.markFired(
      identity,
      ReengagementTouchStatus.Stopped,
      reason,
      ReengagementTouchEventName.Stopped,
    );
  }

  /** 频控丢弃 */
  trackFrequencyBlocked(identity: ReengagementTouchIdentity): void {
    this.markFired(
      identity,
      ReengagementTouchStatus.FrequencyBlocked,
      'over_frequency_limit_24h',
      ReengagementTouchEventName.FrequencyBlocked,
    );
  }

  /** 9-21 窗口外改期 */
  trackRescheduled(
    identity: ReengagementTouchIdentity,
    nextFireAt: number,
    rescheduledJobId: string,
  ): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Rescheduled,
      fireAt: nextFireAt,
      firedAt: Date.now(),
      event: {
        event: ReengagementTouchEventName.RescheduledOutOfWindow,
        detail: { nextFireAt, rescheduledJobId },
      },
    });
  }

  /** shadow 分支：生成了文案但不投递（终态） */
  trackShadow(
    identity: ReengagementTouchIdentity,
    params: { outcomeKind: string; generatedText?: string; reason: string },
  ): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Shadow,
      shadow: true,
      decisionReason: params.reason,
      outcomeKind: params.outcomeKind,
      generatedText: params.generatedText,
      firedAt: Date.now(),
      event: {
        event: ReengagementTouchEventName.ShadowGenerated,
        detail: { outcomeKind: params.outcomeKind, reason: params.reason },
      },
    });
  }

  /** Redis 触达槽撞重，跳过 */
  trackDuplicate(identity: ReengagementTouchIdentity, reserveResult: string): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Duplicate,
      decisionReason: reserveResult,
      reserveResult,
      firedAt: Date.now(),
      event: { event: ReengagementTouchEventName.ReserveDuplicate, detail: { reserveResult } },
    });
  }

  /** 触达槽占位成功（事件，不改终态） */
  trackReserved(identity: ReengagementTouchIdentity): void {
    this.persist({
      ...this.base(identity),
      reserveResult: 'reserved',
      firedAt: Date.now(),
      event: { event: ReengagementTouchEventName.Reserved },
    });
  }

  /** 主动回合结果非 reply，不投递 */
  trackOutcomeNotReply(
    identity: ReengagementTouchIdentity,
    outcomeKind: string,
    batchId?: string,
  ): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Failed,
      decisionReason: ReengagementTouchEventName.OutcomeNotReply,
      outcomeKind,
      batchId,
      event: { event: ReengagementTouchEventName.OutcomeNotReply, detail: { outcomeKind } },
    });
  }

  /** 进入渠道投递（外部平台可能已发出区间） */
  trackDeliveryAttempted(identity: ReengagementTouchIdentity): void {
    this.persist({
      ...this.base(identity),
      event: { event: ReengagementTouchEventName.DeliveryAttempted },
    });
  }

  /** 投递成功（batchId 关联主动回合的消息处理流水行） */
  trackSent(identity: ReengagementTouchIdentity, generatedText?: string, batchId?: string): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Sent,
      shadow: false,
      outcomeKind: 'reply',
      generatedText,
      batchId,
      sentAt: Date.now(),
      event: { event: ReengagementTouchEventName.Sent, detail: batchId ? { batchId } : undefined },
    });
  }

  /** 投递后状态不明（渠道异常，不可盲重投，需人工核对） */
  trackDeliveryUnknown(identity: ReengagementTouchIdentity, error: string, batchId?: string): void {
    this.persist({
      ...this.base(identity),
      status: ReengagementTouchStatus.Unknown,
      error,
      batchId,
      event: { event: ReengagementTouchEventName.DeliveryUnknown, detail: { error } },
    });
  }

  // ==================== 私有 ====================

  private markFired(
    identity: ReengagementTouchIdentity,
    status: ReengagementTouchStatus,
    reason: string,
    eventName: ReengagementTouchEventName,
  ): void {
    this.persist({
      ...this.base(identity),
      status,
      decisionReason: reason,
      firedAt: Date.now(),
      event: { event: eventName, detail: { reason } },
    });
  }

  private base(identity: ReengagementTouchIdentity): RecordReengagementTouchInput {
    return {
      touchKey: ReengagementTrackingService.touchKey(identity),
      sessionId: identity.sessionId,
      userId: identity.userId,
      corpId: identity.corpId,
      scenarioCode: identity.scenarioCode,
      anchorEventId: identity.anchorEventId,
      anchorAt: identity.anchorAt,
      candidateName: identity.candidateName,
      managerName: identity.managerName,
      botImId: identity.botImId,
    };
  }

  private persist(input: RecordReengagementTouchInput): void {
    void this.repository.record(input).catch((error) => {
      this.logger.warn(
        `[二次触发追溯] 落库失败 touchKey=${input.touchKey} event=${input.event?.event}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}
