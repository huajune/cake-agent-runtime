import { Module } from '@nestjs/common';
import { BizMessageModule } from '@biz/message/message.module';
import { UserModule } from '@biz/user/user.module';
import { LlmModule } from '@/llm/llm.module';
import { SpongeModule } from '@sponge/sponge.module';
import { MemoryConfig } from './memory.config';
import { MemoryService } from './memory.service';
import { RedisStore } from './stores/redis.store';
import { CollectionFormStore } from './stores/collection-form.store';
import { CollectionFormService } from './session/collection-form.service';
import { SupabaseStore } from './stores/supabase.store';
import { BrandStateService } from './session/brand-state.service';
import { ShortTermService } from './services/short-term.service';
import { SessionService } from './session/session.service';
import { StageStateService } from './services/stage-state.service';
import { LongTermService } from './long-term/long-term.service';
import { ConsolidationService } from './long-term/consolidation.service';
import { MemoryEnrichmentService } from './services/memory-enrichment.service';
import { MemoryLifecycleService } from './services/memory-lifecycle.service';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { GeocodingModule } from '@infra/geocoding/geocoding.module';

/**
 * Memory 模块
 *
 * 分为三层：
 * - facade: MemoryService
 * - domain services: services/ 下的 short-term / long-term / stageState / consolidation / session / enrichment / lifecycle / brand-state
 * - stores: Redis / Supabase 基础设施
 */
@Module({
  imports: [
    BizMessageModule,
    SpongeModule,
    UserModule,
    LlmModule,
    HostingConfigModule,
    GeocodingModule,
  ],
  providers: [
    MemoryConfig,
    RedisStore,
    CollectionFormStore,
    CollectionFormService,
    SupabaseStore,
    BrandStateService,
    ShortTermService,
    SessionService,
    StageStateService,
    LongTermService,
    ConsolidationService,
    MemoryEnrichmentService,
    MemoryLifecycleService,
    MemoryService,
  ],
  exports: [
    MemoryConfig,
    MemoryService,
    CollectionFormService,
    SessionService,
    LongTermService,
    ShortTermService,
    BrandStateService,
  ],
})
export class MemoryModule {}
