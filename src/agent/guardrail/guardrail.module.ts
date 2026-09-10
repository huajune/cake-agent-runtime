import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmModule } from '@/llm/llm.module';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { InterventionModule } from '@biz/intervention/intervention.module';
import { BizMessageModule } from '@biz/message/message.module';
import { MemoryModule } from '@memory/memory.module';
import { NotificationModule } from '@notification/notification.module';
import { InputGuardrailService } from './input/input-guard.service';
import { PromptInjectionDetector } from './input/prompt-injection-detector';
import { PromptSecurityObserverService } from './input/prompt-security-observer.service';
import { RiskInterceptService } from './input/risk-intercept.service';
import { OutputGuardrailService } from './output/output-guardrail.service';
import { HardRulesService } from './output/rules/hard-rules.service';

@Module({
  imports: [
    ConfigModule,
    LlmModule,
    HostingConfigModule,
    InterventionModule,
    BizMessageModule,
    MemoryModule,
    NotificationModule,
  ],
  providers: [
    InputGuardrailService,
    PromptInjectionDetector,
    PromptSecurityObserverService,
    RiskInterceptService,
    HardRulesService,
    OutputGuardrailService,
  ],
  exports: [
    InputGuardrailService,
    PromptInjectionDetector,
    PromptSecurityObserverService,
    RiskInterceptService,
    HardRulesService,
    OutputGuardrailService,
  ],
})
export class GuardrailModule {}
