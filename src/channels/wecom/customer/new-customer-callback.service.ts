import { Injectable, Logger } from '@nestjs/common';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { NewCustomerCallbackPayload } from './dto/new-customer-callback.dto';
import { BotService } from '../bot/bot.service';

/**
 * 「新增客户回调—RPA」处理：真实加好友 → friend.added。
 *
 * 与消息回调里反推的 friend.added 共用幂等键 `${imContactId}:friend_added` → 天然去重，谁先到算谁。
 * 本回调是主信号（真实加好友即触发、含沉默僵尸）；消息路径的 friend.added 退化为兜底。
 *
 * corp_id：报文不含 orgId，按 imBotId 从企业托管账号列表（BotService）查 bot 所属企业 corpId；
 * 查不到回退 'default'。
 */
@Injectable()
export class NewCustomerCallbackService {
  private readonly logger = new Logger(NewCustomerCallbackService.name);

  // 与 candidate.engaged / 消息路径 friend.added 一致，保证 channel 过滤时同进同出。
  private readonly SOURCE_CHANNEL = 'unknown';

  // bot 所属企业查不到时的兜底 corp_id。
  private readonly DEFAULT_CORP_ID = 'default';

  constructor(
    private readonly opsEventsRecorder: OpsEventsRecorderService,
    private readonly botService: BotService,
  ) {}

  /**
   * 同步 ACK + 异步记录：平台超时会重试（最多 5 次，3 分钟内 10 个全失败封禁回调地址 30 分钟），
   * 故先返回 200，再 fire-and-forget 写事件。
   */
  handleNewCustomer(body: unknown): { success: boolean } {
    const raw = (body ?? {}) as Record<string, unknown>;
    // 文档示例无外层 data，但实际可能带 { data: {...} }，两者都兼容
    const payload = ((raw.data as NewCustomerCallbackPayload) ??
      (raw as NewCustomerCallbackPayload)) as NewCustomerCallbackPayload;

    void this.recordFriendAdded(payload);
    return { success: true };
  }

  private async recordFriendAdded(payload: NewCustomerCallbackPayload): Promise<void> {
    const imContactId = payload.imContactId?.trim();
    if (!imContactId) {
      this.logger.warn('[新增客户回调] 报文缺少 imContactId，跳过 friend.added');
      return;
    }

    const botImId = payload.botInfo?.imBotId?.trim() || null;
    const managerName =
      payload.botInfo?.name?.trim() || payload.imInfo?.followUser?.wecomUserId || null;
    const occurredAt = this.resolveOccurredAt(payload.createTimestamp);

    // 按 imBotId 查 bot 所属企业 corpId（企业托管账号列表）；查不到回退 'default'。
    const corpId = (await this.botService.resolveCorpIdByImBotId(botImId)) ?? this.DEFAULT_CORP_ID;

    try {
      const inserted = await this.opsEventsRecorder.recordEvent({
        corpId,
        eventName: 'friend.added',
        idempotencyKey: `${imContactId}:friend_added`,
        botImId,
        managerName,
        sourceChannel: this.SOURCE_CHANNEL,
        userId: imContactId,
        chatId: null,
        occurredAt,
      });
      this.logger.log(
        `[新增客户回调] friend.added ${inserted ? '已记录' : '幂等跳过'} imContactId=${imContactId} botImId=${botImId ?? '-'}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[新增客户回调] 记录 friend.added 失败 imContactId=${imContactId}: ${message}`,
      );
    }
  }

  /** createTimestamp（毫秒）→ 真实业务时间；缺省/非法时返回 undefined，由 recorder 取当前时间。 */
  private resolveOccurredAt(createTimestamp?: number): Date | undefined {
    if (
      typeof createTimestamp === 'number' &&
      Number.isFinite(createTimestamp) &&
      createTimestamp > 0
    ) {
      return new Date(createTimestamp);
    }
    return undefined;
  }
}
