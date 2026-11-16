import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Job, Queue } from 'bull';
import {
  BOT_ACCOUNT_PROVIDER,
  type BotAccountProvider,
  type BotAccountInfo,
} from '@biz/ops-events/providers/bot-account.provider';
import {
  ReengagementTrackingService,
  type ReengagementTouchIdentity,
} from '@biz/monitoring/services/tracking/reengagement-tracking.service';
import { FOLLOW_UP_JOB_OPTIONS } from '@infra/queue/queue-policy';
import { toErrorMessage } from '@infra/utils/error.util';
import { WECOM_BOT_STATUS } from '@shared-types/wecom-api.types';
import { REENGAGEMENT_HOSTING_RECOVERY_REASON } from '@biz/monitoring/entities/reengagement-touch.entity';
import {
  REENGAGEMENT_JOB_NAME,
  REENGAGEMENT_QUEUE,
  type FollowUpJob,
} from './follow-up-scheduler.service';
import { TouchLedgerService } from './touch-ledger.service';

/** 技术恢复预算：首次延后起 24h；退避基准为 1/2/4/5 分钟，每轮取基准的 50%～100%。 */
export const HOSTING_RECOVERY_MAX_WAIT_MS = 24 * 60 * 60_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

/** 复聊自有恢复链路：Bull 保存排程义务，触达槽保存零发送证明与恢复轮次。 */
@Injectable()
export class ReengagementHostingRecoveryService {
  private readonly logger = new Logger(ReengagementHostingRecoveryService.name);
  private roster?: { expiresAt: number; bots: BotAccountInfo[] };
  private rosterRequest?: Promise<BotAccountInfo[]>;

  constructor(
    @InjectQueue(REENGAGEMENT_QUEUE) private readonly queue: Queue<FollowUpJob>,
    @Inject(BOT_ACCOUNT_PROVIDER) private readonly bots: BotAccountProvider,
    private readonly ledger: TouchLedgerService,
    private readonly tracking: ReengagementTrackingService,
  ) {}

  /** 当前 job 已证明未发送，但保存/入队中断：只补排程，绝不重新生成或投递。 */
  async continuePending(
    job: Job<FollowUpJob>,
    identity: ReengagementTouchIdentity,
  ): Promise<boolean> {
    const recovery = job.data.hostingRecovery;
    if (!recovery) return false;
    if (Date.now() - recovery.firstDeferredAt >= HOSTING_RECOVERY_MAX_WAIT_MS) {
      this.tracking.trackStopped(identity, REENGAGEMENT_HOSTING_RECOVERY_REASON.EXPIRED);
      return true;
    }
    if (recovery.retryAt == null) return false;
    await this.enqueuePending(job.data, identity);
    return true;
  }

  /** 正常任务只按明确离线延后；恢复任务必须读到同一账号在线才允许重新生成。 */
  async deferIfUnavailable(
    job: Job<FollowUpJob>,
    identity: ReengagementTouchIdentity,
  ): Promise<boolean> {
    const status = await this.readBotStatus(identity.botImId);
    const unavailable = job.data.hostingRecovery
      ? status !== WECOM_BOT_STATUS.ONLINE
      : status === WECOM_BOT_STATUS.OFFLINE || status === WECOM_BOT_STATUS.ERROR_LOGOUT;
    if (!unavailable) return false;
    await this.defer(job, identity);
    return true;
  }

  /** 调用者必须提供「未请求发送」或「全部片段明确拒收」的证据。 */
  async defer(
    job: Job<FollowUpJob>,
    identity: ReengagementTouchIdentity,
    deliveryRejected = false,
  ): Promise<void> {
    const previous = job.data.hostingRecovery;
    const now = Date.now();
    const attempt = (previous?.attempt ?? 0) + 1;
    const baseDelayMs = Math.min(60_000 * 2 ** Math.min(attempt - 1, 3), MAX_RETRY_DELAY_MS);
    const halfDelayMs = baseDelayMs / 2;
    // Equal Jitter：每个新轮次独立采样，补入队复用已保存的 retryAt，不重新随机。
    const delayMs = halfDelayMs + Math.floor(Math.random() * halfDelayMs);
    const recovery = {
      firstDeferredAt: previous?.firstDeferredAt ?? now,
      attempt,
      retryAt: now + delayMs,
      ...(deliveryRejected ? { deliveryRejected: true } : {}),
    };
    // 先把未发送的恢复义务交给原 job；后续任一步失败都由原 job 重试补齐。
    const data: FollowUpJob = {
      ...job.data,
      channelIdentity: {
        candidateName: identity.candidateName,
        managerName: identity.managerName,
        botImId: identity.botImId,
        imContactId: identity.imContactId,
        externalUserId: identity.externalUserId,
      },
      hostingRecovery: recovery,
    };
    await job.update(data);
    await this.enqueuePending(data, identity);
  }

  private async enqueuePending(
    data: FollowUpJob,
    identity: ReengagementTouchIdentity,
  ): Promise<void> {
    const recovery = data.hostingRecovery!;
    const key = ReengagementTrackingService.touchKey(identity);
    if (
      !(await this.ledger.markWaitingForHosting(
        key,
        recovery.attempt,
        recovery.deliveryRejected === true,
      ))
    )
      return;
    const jobId = `${key}:hosting-recovery:${recovery.attempt}`;
    await this.queue.add(
      REENGAGEMENT_JOB_NAME,
      {
        ...data,
        hostingRecovery: {
          firstDeferredAt: recovery.firstDeferredAt,
          attempt: recovery.attempt,
        },
      },
      {
        ...FOLLOW_UP_JOB_OPTIONS,
        jobId,
        delay: Math.max(0, recovery.retryAt! - Date.now()),
      },
    );
    this.tracking.trackHostingDeferred(identity, jobId, recovery.retryAt!, recovery.attempt);
  }

  private async readBotStatus(botImId?: string): Promise<number | undefined> {
    if (!botImId?.trim()) return undefined;
    try {
      const roster = await this.getRoster();
      return roster.find((bot) =>
        [bot.wxid, bot.id, bot.wecomUserId, bot.weixin].some((id) => id?.trim() === botImId.trim()),
      )?.status;
    } catch (error) {
      this.logger.warn(`[reengagement] 托管状态读取失败: ${toErrorMessage(error)}`);
      return undefined;
    }
  }

  private async getRoster(): Promise<BotAccountInfo[]> {
    if (this.roster && this.roster.expiresAt > Date.now()) return this.roster.bots;
    if (this.rosterRequest) return this.rosterRequest;
    this.rosterRequest = this.bots.getConfiguredBotList(true).then((bots) => {
      this.roster = { bots, expiresAt: Date.now() + 5_000 };
      return bots;
    });
    try {
      return await this.rosterRequest;
    } finally {
      this.rosterRequest = undefined;
    }
  }
}
