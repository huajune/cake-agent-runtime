import { Global, Module } from '@nestjs/common';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { FeishuAlertChannel } from './channels/feishu-alert.channel';
import { FeishuOpsChannel } from './channels/feishu-ops.channel';
import { FeishuPrivateChatChannel } from './channels/feishu-private-chat.channel';
import { AlertCardRenderer } from './renderers/alert-card.renderer';
import { BookingCardRenderer } from './renderers/booking-card.renderer';
import { OpsCardRenderer } from './renderers/ops-card.renderer';
import { AlertNotifierService } from './services/alert-notifier.service';
import { OpsNotifierService } from './services/ops-notifier.service';
import { PrivateChatMonitorNotifierService } from './services/private-chat-monitor-notifier.service';

@Global()
@Module({
  imports: [FeishuModule],
  providers: [
    FeishuAlertChannel,
    FeishuOpsChannel,
    FeishuPrivateChatChannel,
    AlertCardRenderer,
    BookingCardRenderer,
    OpsCardRenderer,
    AlertNotifierService,
    OpsNotifierService,
    PrivateChatMonitorNotifierService,
  ],
  exports: [AlertNotifierService, OpsNotifierService, PrivateChatMonitorNotifierService],
})
export class NotificationModule {}
