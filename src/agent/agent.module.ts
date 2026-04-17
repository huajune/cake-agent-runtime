import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { MemoryModule } from '@memory/memory.module';
import { NotificationModule } from '@notification/notification.module';
import { CustomerModule } from '@wecom/customer/customer.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { AgentRunnerService } from './runner.service';
import { CompletionService } from './completion.service';
import { AgentPreparationService } from './agent-preparation.service';
import { ContextService } from './context/context.service';
import { AgentController } from './agent.controller';
import { AgentHealthService } from './agent-health.service';
import { InputGuardService } from './input-guard.service';

@Module({
  imports: [
    ConfigModule,
    BizModule,
    ToolModule,
    MemoryModule,
    NotificationModule,
    CustomerModule,
    ObservabilityModule,
  ],
  controllers: [AgentController],
  providers: [
    ContextService,
    AgentPreparationService,
    AgentRunnerService,
    AgentHealthService,
    CompletionService,
    InputGuardService,
  ],
  exports: [
    ContextService,
    AgentPreparationService,
    AgentRunnerService,
    CompletionService,
    InputGuardService,
  ],
})
export class AgentModule {}
