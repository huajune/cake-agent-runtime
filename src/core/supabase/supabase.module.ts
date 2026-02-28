import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@core/client-http';
import { SupabaseService } from './supabase.service';

// Repository 导入
import {
  SystemConfigRepository,
  UserHostingRepository,
  GroupBlacklistRepository,
  ChatMessageRepository,
  MonitoringRepository,
  MessageProcessingRepository,
  BookingRepository,
  StrategyConfigRepository,
} from './repositories';

/**
 * Repository 提供者列表
 */
const REPOSITORIES = [
  SystemConfigRepository,
  UserHostingRepository,
  GroupBlacklistRepository,
  ChatMessageRepository,
  MonitoringRepository,
  MessageProcessingRepository,
  BookingRepository,
  StrategyConfigRepository,
];

/**
 * Supabase 模块
 *
 * 全局模块，提供：
 * - SupabaseService: 基础设施层（HTTP 客户端、缓存）
 * - *Repository: 各业务域数据访问层
 *
 * 架构说明：
 * - 所有 Repository 继承 BaseRepository
 * - 通过 SupabaseService 获取共享的 HTTP 客户端
 * - 遵循 Repository Pattern，封装数据访问逻辑
 */
@Global()
@Module({
  imports: [HttpModule],
  providers: [SupabaseService, ...REPOSITORIES],
  exports: [SupabaseService, ...REPOSITORIES],
})
export class SupabaseModule {}
