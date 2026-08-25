import { Module } from '@nestjs/common';
import { BizMessageModule } from '@biz/message/message.module';
import { UserModule } from '@biz/user/user.module';
import { LlmModule } from '@/llm/llm.module';
import { SpongeModule } from '@sponge/sponge.module';
import { MemoryConfig } from './memory.config';
import { MemoryService } from './memory.service';
import { RedisStore } from './stores/redis.store';
import { CollectionFormStore } from './stores/collection-form.store';
import { CollectionFormService } from './short-term/collection-form.service';
import { SupabaseStore } from './stores/supabase.store';
import { BrandStateService } from './short-term/brand-state.service';
import { MessageWindowService } from './short-term/message-window.service';
import { SessionSemanticService } from './short-term/session-semantic.service';
import { SessionFactsService } from './short-term/facts.service';
import { SessionWorkbenchService } from './short-term/workbench.service';
import { LongTermService } from './long-term/long-term.service';
import { ConsolidationService } from './long-term/consolidation.service';
import { MemoryEnrichmentService } from './enrichment.service';
import { MemoryLifecycleService } from './lifecycle.service';
import { HostingConfigModule } from '@biz/hosting-config/hosting-config.module';
import { GeocodingModule } from '@infra/geocoding/geocoding.module';

/**
 * Memory 模块
 *
 * 组织轴：short-term（message-window + session-semantic 两舱）/ long-term；
 * lifecycle 与 enrichment 是跨层服务，stores 保持独立基础设施层。
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
    MessageWindowService,
    SessionSemanticService,
    SessionFactsService,
    SessionWorkbenchService,
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
    SessionSemanticService,
    SessionFactsService,
    SessionWorkbenchService,
    LongTermService,
    MessageWindowService,
    BrandStateService,
  ],
})
export class MemoryModule {}
