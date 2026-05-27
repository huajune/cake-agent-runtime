import { Injectable, Logger } from '@nestjs/common';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { FeishuAlertChannel } from '../channels/feishu-alert.channel';
import { FeishuPrivateChatChannel } from '../channels/feishu-private-chat.channel';
import { GeneralHandoffCardRenderer } from '../renderers/general-handoff-card.renderer';
import { GeneralHandoffNotificationPayload } from '../types/general-handoff-notification.types';

/**
 * 测试/调试链路识别。
 *
 * **首要信号**：`corpId === 'test' | 'debug'` —— 这两个值由代码常量写死
 * （TestExecutionService.TEST_CORP_ID / agent.controller.ts），业务侧 corpId
 * 是真实企业号，绝不会撞上。
 *
 * **兜底信号**：sessionId 前缀匹配——给少数仍可能漏传 corpId 的旧路径兜底。
 * 业务侧 chatId 为微信 chatId（如 `wrkSE...`），不会以这些前缀开头。
 */
const TEST_CORP_IDS = new Set(['test', 'debug']);
const TEST_SESSION_PREFIXES = ['test-', 'p1-fixed-', 'p2-fixed-', 'p3-fixed-'];

function isTestSession(corpId: string, chatId: string): boolean {
  if (TEST_CORP_IDS.has(corpId)) return true;
  return TEST_SESSION_PREFIXES.some((prefix) => chatId.startsWith(prefix));
}

@Injectable()
export class GeneralHandoffNotifierService {
  private readonly logger = new Logger(GeneralHandoffNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly alertChannel: FeishuAlertChannel,
    private readonly cardRenderer: GeneralHandoffCardRenderer,
  ) {}

  async notify(payload: GeneralHandoffNotificationPayload): Promise<boolean> {
    const isTest = isTestSession(payload.corpId, payload.chatId);
    const receiver = !isTest && payload.botImId ? BOT_TO_RECEIVER[payload.botImId] : undefined;

    const card = this.cardRenderer.buildCard({
      ...payload,
      isTest,
      ...(isTest ? {} : receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const targetChannel = isTest ? this.alertChannel : this.privateChatChannel;
    const success = await targetChannel.send(card);
    const tag = isTest ? '[测试]' : '';
    if (success) {
      this.logger.warn(
        `通用人工介入告警已发送${tag}: chatId=${payload.chatId}, label=${payload.alertLabel}`,
      );
    } else {
      this.logger.warn(
        `通用人工介入告警发送失败${tag}: chatId=${payload.chatId}, label=${payload.alertLabel}`,
      );
    }
    return success;
  }
}
