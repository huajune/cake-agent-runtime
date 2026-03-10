import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

// 按业务域导入
import {
  SystemConfigRepository,
  SystemConfigService,
  GroupBlacklistRepository,
  GroupBlacklistService,
} from './config';

import { UserHostingRepository, UserHostingService } from './user';

import { StrategyConfigRepository, StrategyConfigService } from './agent';

import { ChatMessageRepository, MessageProcessingRepository, BookingRepository } from './message';

import {
  MonitoringRepository,
  MonitoringHourlyStatsRepository,
  MonitoringErrorLogRepository,
} from './monitoring';

import {
  TestBatchRepository,
  TestExecutionRepository,
  ConversationSourceRepository,
} from './test-suite';

/**
 * Repository 提供者列表
 */
const REPOSITORIES = [
  // config
  SystemConfigRepository,
  GroupBlacklistRepository,
  // user
  UserHostingRepository,
  // agent
  StrategyConfigRepository,
  // message
  ChatMessageRepository,
  MessageProcessingRepository,
  BookingRepository,
  // monitoring
  MonitoringRepository,
  MonitoringHourlyStatsRepository,
  MonitoringErrorLogRepository,
  // test-suite
  TestBatchRepository,
  TestExecutionRepository,
  ConversationSourceRepository,
];

/**
 * Service 提供者列表
 */
const SERVICES = [
  SystemConfigService,
  GroupBlacklistService,
  UserHostingService,
  StrategyConfigService,
];

/**
 * Supabase 模块
 *
 * 全局模块，提供：
 * - SupabaseService: 基础设施层（HTTP 客户端、缓存）
 * - *Repository: 各业务域数据访问层
 * - *Service: 业务编排层（缓存、跨表逻辑）
 *
 * 架构说明：
 * - 按业务域组织：config / user / agent / message / monitoring / test-suite
 * - 所有 Repository 继承 BaseRepository
 * - 通过 SupabaseService 获取共享的 HTTP 客户端
 * - 遵循 Repository Pattern，封装数据访问逻辑
 */
@Global()
@Module({
  providers: [SupabaseService, ...REPOSITORIES, ...SERVICES],
  exports: [SupabaseService, ...REPOSITORIES, ...SERVICES],
})
export class SupabaseModule {}
