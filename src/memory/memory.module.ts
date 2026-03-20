import { Module } from '@nestjs/common';
import { BizMessageModule } from '@biz/message/message.module';
import { MemoryConfig } from './memory.config';
import { MemoryService } from './memory.service';
import { RedisStore } from './stores/redis.store';
import { SupabaseStore } from './stores/supabase.store';
import { ShortTermService } from './short-term.service';
import { SessionFactsService } from './session-facts.service';
import { ProceduralService } from './procedural.service';
import { LongTermService } from './long-term.service';

@Module({
  imports: [BizMessageModule],
  providers: [
    MemoryConfig,
    RedisStore,
    SupabaseStore,
    ShortTermService,
    SessionFactsService,
    ProceduralService,
    LongTermService,
    MemoryService,
  ],
  exports: [MemoryConfig, MemoryService, SessionFactsService, ProceduralService, LongTermService],
})
export class MemoryModule {}
