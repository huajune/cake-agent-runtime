import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { BizModule } from '@biz/biz.module';
import { ToolModule } from '@tools/tool.module';
import { GroupTaskModule } from '@biz/group-task/group-task.module';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { LlmModule } from '@/llm/llm.module';
import { NotificationModule } from '@notification/notification.module';
import { CustomerModule } from '@wecom/customer/customer.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { GeneratorService } from './generator/generator.service';
import { TurnRunnerService } from './runner/turn-runner.service';
import { AgentPreparationService } from './agent-preparation.service';
import { ContextService } from './context/context.service';
import { AgentController } from './agent.controller';
import { AgentHealthService } from './agent-health.service';
import { InputGuardrailService } from './guardrail/input/input-guard.service';
import { REENGAGEMENT_QUEUE } from './reengagement/reengagement.types';
import { FollowUpSchedulerService } from './reengagement/follow-up-scheduler.service';
import { FollowUpProcessor } from './reengagement/follow-up.processor';
import { TouchLedgerService } from './reengagement/touch-ledger.service';

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
    BullModule.registerQueue({
      name: REENGAGEMENT_QUEUE,
      defaultJobOptions: {
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
      },
    }),
  ],
  controllers: [AgentController],
  providers: [
    ContextService,
    AgentPreparationService,
    GeneratorService,
    TurnRunnerService,
    AgentHealthService,
    InputGuardrailService,
    // reengagement（复聊 shadow）
    FollowUpSchedulerService,
    FollowUpProcessor,
    TouchLedgerService,
  ],
  exports: [
    ContextService,
    AgentPreparationService,
    GeneratorService,
    TurnRunnerService,
    InputGuardrailService,
    FollowUpSchedulerService,
  ],
})
export class AgentModule {}
