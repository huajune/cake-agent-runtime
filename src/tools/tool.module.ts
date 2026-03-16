import { Module, OnModuleInit } from '@nestjs/common';
import { MemoryModule } from '@memory/memory.module';
import { SpongeModule } from '@sponge/sponge.module';
import { ToolRegistryService } from './tool-registry.service';
import { WeworkPlanTurnToolService } from './wework-plan-turn.tool';
import { DulidayJobListToolService } from './duliday-job-list.tool';
import { DulidayInterviewBookingToolService } from './duliday-interview-booking.tool';
import { MemoryStoreToolService } from './memory-store.tool';
import { MemoryRecallToolService } from './memory-recall.tool';

@Module({
  imports: [MemoryModule, SpongeModule],
  providers: [
    ToolRegistryService,
    WeworkPlanTurnToolService,
    DulidayJobListToolService,
    DulidayInterviewBookingToolService,
    MemoryStoreToolService,
    MemoryRecallToolService,
  ],
  exports: [ToolRegistryService],
})
export class ToolModule implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistryService,
    private readonly planTurn: WeworkPlanTurnToolService,
    private readonly jobList: DulidayJobListToolService,
    private readonly booking: DulidayInterviewBookingToolService,
    private readonly memStore: MemoryStoreToolService,
    private readonly memRecall: MemoryRecallToolService,
  ) {}

  onModuleInit() {
    this.registry.registerFactory(this.planTurn);
    this.registry.registerFactory(this.jobList);
    this.registry.registerFactory(this.booking);
    this.registry.registerFactory(this.memStore);
    this.registry.registerFactory(this.memRecall);
  }
}
