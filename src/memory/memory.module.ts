import { Module } from '@nestjs/common';
import { MemoryService } from './memory.service';
import { RedisStore } from './redis.store';
import { SupabaseStore } from './supabase.store';
@Module({
  providers: [RedisStore, SupabaseStore, MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
