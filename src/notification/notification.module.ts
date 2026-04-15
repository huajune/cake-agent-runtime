import { Global, Module, forwardRef } from '@nestjs/common';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { UserModule } from '@biz/user/user.module';
import { RecruitmentCaseModule } from '@biz/recruitment-case/recruitment-case.module';
import { FeishuAlertChannel } from './channels/feishu-alert.channel';
import { FeishuOpsChannel } from './channels/feishu-ops.channel';
import { FeishuPrivateChatChannel } from './channels/feishu-private-chat.channel';
import { AlertCardRenderer } from './renderers/alert-card.renderer';
import { BookingCardRenderer } from './renderers/booking-card.renderer';
import { ConversationRiskCardRenderer } from './renderers/conversation-risk-card.renderer';
import { OnboardFollowupCardRenderer } from './renderers/onboard-followup-card.renderer';
import { OpsCardRenderer } from './renderers/ops-card.renderer';
import { AlertNotifierService } from './services/alert-notifier.service';
import { ConversationRiskNotifierService } from './services/conversation-risk-notifier.service';
import { OnboardFollowupNotifierService } from './services/onboard-followup-notifier.service';
import { OpsNotifierService } from './services/ops-notifier.service';
import { PrivateChatMonitorNotifierService } from './services/private-chat-monitor-notifier.service';
import { InterventionService } from './intervention/intervention.service';

@Global()
@Module({
  imports: [FeishuModule, forwardRef(() => UserModule), forwardRef(() => RecruitmentCaseModule)],
  providers: [
    FeishuAlertChannel,
    FeishuOpsChannel,
    FeishuPrivateChatChannel,
    AlertCardRenderer,
    BookingCardRenderer,
    ConversationRiskCardRenderer,
    OnboardFollowupCardRenderer,
    OpsCardRenderer,
    AlertNotifierService,
    ConversationRiskNotifierService,
    OnboardFollowupNotifierService,
    OpsNotifierService,
    PrivateChatMonitorNotifierService,
    InterventionService,
  ],
  exports: [
    AlertNotifierService,
    ConversationRiskNotifierService,
    OnboardFollowupNotifierService,
    OpsNotifierService,
    PrivateChatMonitorNotifierService,
    InterventionService,
  ],
})
export class NotificationModule {}
