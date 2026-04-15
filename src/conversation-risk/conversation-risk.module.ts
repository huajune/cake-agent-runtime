import { Module } from '@nestjs/common';
import { AgentModule } from '@agent/agent.module';
import { BizMessageModule } from '@biz/message/message.module';
import { UserModule } from '@biz/user/user.module';
import { MemoryModule } from '@memory/memory.module';
import { NotificationModule } from '@notification/notification.module';
import { ConversationRiskActionService } from './services/conversation-risk-action.service';
import { ConversationRiskContextService } from './services/conversation-risk-context.service';
import { ConversationRiskDetectorService } from './services/conversation-risk-detector.service';
import { ConversationRiskLlmAnalyzerService } from './services/conversation-risk-llm-analyzer.service';
import { ConversationRiskService } from './services/conversation-risk.service';

@Module({
  imports: [AgentModule, BizMessageModule, UserModule, MemoryModule, NotificationModule],
  providers: [
    ConversationRiskService,
    ConversationRiskContextService,
    ConversationRiskDetectorService,
    ConversationRiskLlmAnalyzerService,
    ConversationRiskActionService,
  ],
  exports: [ConversationRiskService],
})
export class ConversationRiskModule {}
