import { Module, forwardRef } from '@nestjs/common';
import { GeocodingModule } from '@infra/geocoding/geocoding.module';
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
import { MessageModule } from '@wecom/message/message.module';
import { ObservabilityModule } from '@/observability/observability.module';
import { OpsEventsModule } from '@biz/ops-events/ops-events.module';
import { HandoffEventsModule } from '@biz/handoff-events/handoff-events.module';
import { GeneratorAgent } from './generator/generator.agent';
import { AgentRunnerService } from './runner/agent-runner.service';
import { ReplyRepairAgent } from './reply-repair/reply-repair.agent';
import { ReplyRepairContextProvider } from './reply-repair/reply-repair-context.provider';
import { TurnOutcomeInterventionService } from './runner/turn-outcome-intervention.service';
import { PreparationService } from './generator/preparation/preparation.service';
import { ToolRuntimeBuilderService } from './generator/preparation/tool-context.builder';
import { TurnDataLoaderService } from './generator/preparation/turn-data-loader.service';
import { BookingContextLoaderService } from './generator/preparation/booking-context-loader.service';
import { PreparationModule } from './generator/preparation/preparation.module';
import { ContextService } from './generator/context/context.service';
import { AgentController } from './agent.controller';
import { AgentHealthService } from './agent-health.service';
import { InterventionModule } from '@biz/intervention/intervention.module';
import { GuardrailModule } from './guardrail/guardrail.module';
import { REENGAGEMENT_QUEUE } from './reengagement/follow-up-scheduler.service';
import { FollowUpSchedulerService } from './reengagement/follow-up-scheduler.service';
import { FollowUpProcessor } from './reengagement/follow-up.processor';
import { TouchLedgerService } from './reengagement/touch-ledger.service';
import { ReengagementAnchorService } from './reengagement/anchor.service';
import { ReengagementAgent } from './reengagement/reengagement.agent';
import { OnboardingSweepCronService } from './reengagement/onboarding-sweep.cron';
import {
  REENGAGEMENT_DELIVERY_PORT,
  ReengagementDeliveryService,
} from './reengagement/follow-up.processor';

@Module({
  imports: [
    ConfigModule,
    GeocodingModule,
    BizModule,
    ToolModule,
    GroupTaskModule,
    MemoryModule,
    PreparationModule,
    SpongeModule,
    LlmModule,
    NotificationModule,
    CustomerModule,
    forwardRef(() => MessageModule),
    ObservabilityModule,
    OpsEventsModule,
    HandoffEventsModule,
    InterventionModule,
    GuardrailModule,
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
    BookingContextLoaderService,
    TurnDataLoaderService,
    ToolRuntimeBuilderService,
    PreparationService,
    GeneratorAgent,
    ReplyRepairAgent,
    ReplyRepairContextProvider,
    AgentRunnerService,
    TurnOutcomeInterventionService,
    AgentHealthService,
    // reengagement（复聊二次触达；shadow/投递由 Dashboard 运行时开关控制）
    FollowUpSchedulerService,
    FollowUpProcessor,
    TouchLedgerService,
    ReengagementAnchorService,
    ReengagementAgent,
    OnboardingSweepCronService,
    ReengagementDeliveryService,
    { provide: REENGAGEMENT_DELIVERY_PORT, useExisting: ReengagementDeliveryService },
  ],
  exports: [
    ContextService,
    PreparationService,
    GeneratorAgent,
    ReplyRepairAgent,
    ReplyRepairContextProvider,
    AgentRunnerService,
    TurnOutcomeInterventionService,
    GuardrailModule,
    FollowUpSchedulerService,
    ReengagementAnchorService,
  ],
})
export class AgentModule {}
