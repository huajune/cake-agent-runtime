import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmModule } from '@/llm/llm.module';
import { ConversationRiskModule } from '@/conversation-risk/conversation-risk.module';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { InterventionModule } from '@biz/intervention/intervention.module';
import { BizMessageModule } from '@biz/message/message.module';
import { MemoryModule } from '@memory/memory.module';
import { NotificationModule } from '@notification/notification.module';
import { InputGuardrailService } from './input/input-guard.service';
import { PromptInjectionService } from './input/prompt-injection.service';
import { RiskInterceptService } from './input/risk-intercept.service';
import { OutputGuardrailService } from './output/output-guardrail.service';
import { HardRulesService } from './output/hard-rules.service';
import { GuardrailReviewPacketBuilder } from './output/llm/review-packet.builder';
import { SemanticReviewerService } from './output/llm/semantic-reviewer.service';

@Module({
  imports: [
    ConfigModule,
    LlmModule,
    ConversationRiskModule,
    HostingConfigModule,
    InterventionModule,
    BizMessageModule,
    MemoryModule,
    NotificationModule,
  ],
  providers: [
    InputGuardrailService,
    PromptInjectionService,
    RiskInterceptService,
    HardRulesService,
    GuardrailReviewPacketBuilder,
    SemanticReviewerService,
    OutputGuardrailService,
  ],
  exports: [
    InputGuardrailService,
    PromptInjectionService,
    RiskInterceptService,
    HardRulesService,
    GuardrailReviewPacketBuilder,
    SemanticReviewerService,
    OutputGuardrailService,
  ],
})
export class GuardrailModule {}
