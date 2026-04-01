import { Module } from '@nestjs/common';
import { BizMessageModule } from '@biz/message/message.module';
import { SpongeModule } from '@sponge/sponge.module';
import { MemoryConfig } from './memory.config';
import { MemoryService } from './memory.service';
import { RedisStore } from './stores/redis.store';
import { SupabaseStore } from './stores/supabase.store';
import { ShortTermService } from './services/short-term.service';
import { SessionService } from './services/session.service';
import { ProceduralService } from './services/procedural.service';
import { LongTermService } from './services/long-term.service';
import { SettlementService } from './services/settlement.service';
import { MemoryLifecycleService } from './services/memory-lifecycle.service';

/**
 * Memory 模块
 *
 * 分为三层：
 * - facade: MemoryService
 * - domain services: services/ 下的 short-term / long-term / procedural / settlement / session / memory-lifecycle
 * - stores: Redis / Supabase 基础设施
 */
@Module({
  imports: [BizMessageModule, SpongeModule],
  providers: [
    MemoryConfig,
    RedisStore,
    SupabaseStore,
    ShortTermService,
    SessionService,
    ProceduralService,
    LongTermService,
    SettlementService,
    MemoryLifecycleService,
    MemoryService,
  ],
  exports: [MemoryConfig, MemoryService],
})
export class MemoryModule {}
