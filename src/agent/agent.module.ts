import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { GroupTaskModule } from '@biz/group-task/group-task.module';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { LlmModule } from '@/llm/llm.module';
import { NotificationModule } from '@notification/notification.module';
import { CustomerModule } from '@wecom/customer/customer.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { AgentRunnerService } from './runner.service';
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
    GroupTaskModule,
    MemoryModule,
    SpongeModule,
    LlmModule,
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
    InputGuardService,
  ],
  exports: [ContextService, AgentPreparationService, AgentRunnerService, InputGuardService],
})
export class AgentModule {}
