import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { LlmModule } from '@/llm/llm.module';
import { SpongeModule } from '@sponge/sponge.module';
import { MemoryConfig } from './memory.config';
import { MemoryService } from './memory.service';
import { RedisStore } from './stores/redis.store';
import { SupabaseStore } from './stores/supabase.store';
import { BrandStateService } from './short-term/brand-state.service';
import { MessageWindowService } from './short-term/message-window.service';
import { SessionStateService } from './short-term/session-state.service';
import { SessionFactsService } from './short-term/facts.service';
import { SessionWorkbenchService } from './short-term/workbench.service';
import { LongTermService } from './long-term/long-term.service';
import { ConsolidationService } from './long-term/consolidation.service';
import {
  MEMORY_CONSOLIDATION_QUEUE,
  ConsolidationSchedulerService,
} from './long-term/consolidation-scheduler.service';
import { ConsolidationProcessor } from './long-term/consolidation.processor';
import { MemoryLifecycleService } from './lifecycle.service';
import { GeocodingModule } from '@infra/geocoding/geocoding.module';
import { ObservabilityModule } from '@observability/observability.module';
import { PreparationModule } from '@agent/generator/preparation/preparation.module';

/**
 * Memory 模块
 *
 * 组织轴：short-term（message-window + session-state）/ long-term；
 * lifecycle 是跨层服务，stores 保持独立基础设施层；biz 依赖由 preparation 端口适配。
 */
@Module({
  imports: [
    PreparationModule,
    SpongeModule,
    LlmModule,
    GeocodingModule,
    ObservabilityModule,
    BullModule.registerQueue({
      name: MEMORY_CONSOLIDATION_QUEUE,
    }),
  ],
  providers: [
    MemoryConfig,
    RedisStore,
    SupabaseStore,
    BrandStateService,
    MessageWindowService,
    SessionStateService,
    SessionFactsService,
    SessionWorkbenchService,
    LongTermService,
    ConsolidationService,
    ConsolidationSchedulerService,
    ConsolidationProcessor,
    MemoryLifecycleService,
    MemoryService,
  ],
  exports: [
    MemoryConfig,
    MemoryService,
    SessionStateService,
    SessionFactsService,
    SessionWorkbenchService,
    LongTermService,
    MessageWindowService,
    BrandStateService,
  ],
})
export class MemoryModule {}
