import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

/**
 * Supabase 基础设施模块
 *
 * 全局模块，仅提供 SupabaseService（数据库客户端）。
 * Repository 分散在各业务域自己的 Module 里声明为 provider（MonitoringModule 等），
 * 经构造函数注入这里导出的 SupabaseService；不存在集中式的 DbModule。
 */
@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
