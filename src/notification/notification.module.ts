import { Global, Module } from '@nestjs/common';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { FeishuSyncModule } from '@biz/feishu-sync/feishu-sync.module';
import { FeishuAlertChannel } from './channels/feishu-alert.channel';
import { FeishuOpsChannel } from './channels/feishu-ops.channel';
import { FeishuPrivateChatChannel } from './channels/feishu-private-chat.channel';
import { AlertCardRenderer } from './renderers/alert-card.renderer';
import { BookingCardRenderer } from './renderers/booking-card.renderer';
import { ConversationRiskCardRenderer } from './renderers/conversation-risk-card.renderer';
import { GeneralHandoffCardRenderer } from './renderers/general-handoff-card.renderer';
import { OpsCardRenderer } from './renderers/ops-card.renderer';
import { AlertNotifierService } from './services/alert-notifier.service';
import { ConversationRiskNotifierService } from './services/conversation-risk-notifier.service';
import { GeneralHandoffNotifierService } from './services/general-handoff-notifier.service';
import { OpsNotifierService } from './services/ops-notifier.service';
import { PrivateChatMonitorNotifierService } from './services/private-chat-monitor-notifier.service';
import { ReplyFactGuardNotifierService } from './services/reply-fact-guard-notifier.service';
import { SemanticReviewNotifierService } from './services/semantic-review-notifier.service';

@Global()
@Module({
  imports: [FeishuModule, FeishuSyncModule],
  providers: [
    FeishuAlertChannel,
    FeishuOpsChannel,
    FeishuPrivateChatChannel,
    AlertCardRenderer,
    BookingCardRenderer,
    ConversationRiskCardRenderer,
    GeneralHandoffCardRenderer,
    OpsCardRenderer,
    AlertNotifierService,
    ConversationRiskNotifierService,
    GeneralHandoffNotifierService,
    OpsNotifierService,
    PrivateChatMonitorNotifierService,
    ReplyFactGuardNotifierService,
    SemanticReviewNotifierService,
  ],
  exports: [
    AlertNotifierService,
    ConversationRiskNotifierService,
    GeneralHandoffNotifierService,
    OpsNotifierService,
    PrivateChatMonitorNotifierService,
    ReplyFactGuardNotifierService,
    SemanticReviewNotifierService,
  ],
})
export class NotificationModule {}
