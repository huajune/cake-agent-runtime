import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

/**
 * Supabase 基础设施模块
 *
 * 全局模块，仅提供 SupabaseService（数据库客户端）。
 * 所有 Repository 由 DbModule 管理。
 */
@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
