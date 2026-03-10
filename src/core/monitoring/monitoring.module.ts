import { Module, Global, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';
import { DashboardController } from './dashboard.controller';
import { MonitoringDashboardController } from './controllers/monitoring-dashboard.controller';
import { MonitoringChatController } from './controllers/monitoring-chat.controller';
import { MonitoringMessagesController } from './controllers/monitoring-messages.controller';
import { MonitoringAdminController } from './controllers/monitoring-admin.controller';
import { MonitoringCacheService } from './monitoring-cache.service';
import { MonitoringAlertService } from './monitoring-alert.service';
import { DataCleanupService } from './data-cleanup.service';
import { HourlyStatsAggregatorService } from './hourly-stats-aggregator.service';
import { MessageTrackingService } from './services/message-tracking.service';
import { DashboardStatsService } from './services/dashboard-stats.service';
import { MessageModule } from '@wecom/message/message.module';
import { FeishuModule } from '@/core/feishu/feishu.module';

/**
 * 监控模块
 * 全局模块，可在整个应用中使用
 *
 * 服务架构:
 * - MonitoringService: 门面层，统一对外 API
 *   - MessageTrackingService: 消息生命周期追踪
 *   - DashboardStatsService: Dashboard 数据聚合与统计
 * - MonitoringCacheService: Redis 实时指标缓存
 * - DataCleanupService: 定期清理过期数据
 * - MonitoringAlertService: 业务指标主动告警
 * - HourlyStatsAggregatorService: 小时统计历史聚合
 *
 * 注：数据库访问通过全局 SupabaseModule 的 Repository 直接注入，
 *     无需中间委托层 MonitoringDatabaseService。
 *
 * 控制器架构:
 * - MonitoringDashboardController: Dashboard 概览、趋势、指标、用户
 * - MonitoringChatController: 聊天记录、会话列表
 * - MonitoringMessagesController: 消息处理记录
 * - MonitoringAdminController: 数据管理（用户托管、黑名单、Agent 配置）→ 直接用 Supabase Service
 * - MonitoringController: 运行时状态（AI 开关、聚合开关、Worker）→ MessageService/MessageProcessor
 * - DashboardController: SPA 静态资源路由
 */
@Global()
@Module({
  imports: [ScheduleModule.forRoot(), forwardRef(() => MessageModule), FeishuModule],
  controllers: [
    MonitoringDashboardController,
    MonitoringChatController,
    MonitoringMessagesController,
    MonitoringAdminController,
    MonitoringController,
    DashboardController,
  ],
  providers: [
    // 基础服务
    MonitoringCacheService,
    HourlyStatsAggregatorService,
    // 核心子服务
    MessageTrackingService,
    DashboardStatsService,
    // 门面层
    MonitoringService,
    // 辅助服务
    DataCleanupService,
    MonitoringAlertService,
  ],
  exports: [
    MonitoringService,
    MessageTrackingService,
    DashboardStatsService,
    MonitoringAlertService,
    MonitoringCacheService,
    DataCleanupService,
    HourlyStatsAggregatorService,
  ],
})
export class MonitoringModule {}
