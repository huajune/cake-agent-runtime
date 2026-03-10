import { Module, Global, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@core/client-http/http.module';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';
import { DashboardController } from './dashboard.controller';
import { MonitoringDatabaseService } from './monitoring-database.service';
import { MonitoringCacheService } from './monitoring-cache.service';
import { MonitoringMigrationService } from './monitoring-migration.service';
import { MonitoringAlertService } from './monitoring-alert.service';
import { DataCleanupService } from './data-cleanup.service';
import { HourlyStatsAggregatorService } from './hourly-stats-aggregator.service';
import { MessageModule } from '@wecom/message/message.module';
import { FeishuModule } from '@/core/feishu/feishu.module';

/**
 * 监控模块
 * 全局模块，可在整个应用中使用
 *
 * 服务说明:
 * - MonitoringService: 核心监控数据收集与统计
 * - MonitoringDatabaseService: Supabase 数据持久化（详细记录、小时统计、错误日志）
 * - MonitoringCacheService: Redis 实时指标缓存（计数器、活跃用户、并发数）
 * - DataCleanupService: 定期清理过期数据 (聊天消息、历史监控数据)
 * - MonitoringAlertService: 业务指标主动告警
 *
 * 存储策略:
 * - Supabase: 详细记录、小时统计、错误日志、每日统计（永久存储）
 * - Redis: 全局计数器、活跃用户/会话、实时并发数（24h TTL）
 */
@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(), // 启用定时任务
    HttpModule, // HTTP 客户端工厂
    forwardRef(() => MessageModule),
    FeishuModule, // 飞书通知服务
  ],
  controllers: [MonitoringController, DashboardController],
  providers: [
    MonitoringService,
    MonitoringDatabaseService,
    MonitoringCacheService,
    MonitoringMigrationService, // 数据迁移服务
    DataCleanupService, // 定期清理过期数据
    MonitoringAlertService, // 业务指标告警
    HourlyStatsAggregatorService, // 小时统计历史聚合
  ],
  exports: [
    MonitoringService,
    MonitoringAlertService,
    MonitoringDatabaseService,
    MonitoringCacheService,
    DataCleanupService,
    HourlyStatsAggregatorService,
  ],
})
export class MonitoringModule {}
