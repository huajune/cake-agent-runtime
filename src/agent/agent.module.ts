import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { MemoryModule } from '@memory/memory.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { AgentRunnerService } from './runner.service';
import { CompletionService } from './completion.service';
import { AgentPreparationService } from './agent-preparation.service';
import { ContextService } from './context/context.service';
import { AgentController } from './agent.controller';
import { AgentHealthService } from './agent-health.service';
import { InputGuardService } from './input-guard.service';
import { BookingDetectionService } from '@wecom/message/services/booking-detection.service';

@Module({
  imports: [ConfigModule, FeishuModule, BizModule, ToolModule, MemoryModule, ObservabilityModule],
  controllers: [AgentController],
  providers: [
    ContextService,
    AgentPreparationService,
    AgentRunnerService,
    AgentHealthService,
    CompletionService,
    InputGuardService,
    BookingDetectionService,
  ],
  exports: [
    ContextService,
    AgentPreparationService,
    AgentRunnerService,
    CompletionService,
    InputGuardService,
    BookingDetectionService,
  ],
})
export class AgentModule {}
