import { Module } from '@nestjs/common';
import { BizMessageModule } from '@biz/message/message.module';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { UserModule } from '@biz/user/user.module';
import {
  MEMORY_CHAT_SESSION_PORT,
  MEMORY_MESSAGE_PROCESSING_PORT,
  MEMORY_SYSTEM_CONFIG_PORT,
} from '@memory/memory.ports';
import { SnapshotEnrichmentService } from './snapshot-enrichment.service';

/** generator 备料车间的 DI 接缝：快照装饰 + memory 对业务服务的窄端口绑定。 */
@Module({
  imports: [BizMessageModule, HostingConfigModule, UserModule],
  providers: [
    SnapshotEnrichmentService,
    { provide: MEMORY_CHAT_SESSION_PORT, useExisting: ChatSessionService },
    { provide: MEMORY_SYSTEM_CONFIG_PORT, useExisting: SystemConfigService },
    { provide: MEMORY_MESSAGE_PROCESSING_PORT, useExisting: MessageProcessingService },
  ],
  exports: [
    SnapshotEnrichmentService,
    MEMORY_CHAT_SESSION_PORT,
    MEMORY_SYSTEM_CONFIG_PORT,
    MEMORY_MESSAGE_PROCESSING_PORT,
  ],
})
export class PreparationModule {}
