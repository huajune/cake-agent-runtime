import { Module, Global, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MessageModule } from '@wecom/message/message.module';
import { BizMessageModule } from '@biz/message/message.module';
import { AnalyticsModule } from '@analytics/analytics.module';
import { NotificationModule } from '@notification/notification.module';
import { ObservabilityModule } from '@observability/observability.module';
import { UserModule } from '../user/user.module';
import { HostingConfigModule } from '../hosting-config/hosting-config.module';

// Tracking (采集写入)
import { MessageTrackingService } from './services/tracking/message-tracking.service';
import { MonitoringCacheService } from './services/tracking/monitoring-cache.service';

// Dashboard / Alerts / Maintenance / Projections (应用编排)
import { AnalyticsDashboardService } from './services/dashboard/analytics-dashboard.service';
import { AnalyticsQueryService } from './services/dashboard/analytics-query.service';
import { AnalyticsMaintenanceService } from './services/maintenance/analytics-maintenance.service';
import { DailyStatsAggregatorService } from './services/projections/daily-stats-aggregator.service';
import { HourlyStatsAggregatorService } from './services/projections/hourly-stats-aggregator.service';
import { AnalyticsAlertService } from './services/alerts/analytics-alert.service';

// Cleanup (数据清理)
import { DataCleanupService } from './services/cleanup/data-cleanup.service';

// Controllers
import { AnalyticsController, MonitoringController } from './monitoring.controller';

// Repositories
import { MonitoringRecordRepository } from './repositories/record.repository';
import { MonitoringDailyStatsRepository } from './repositories/daily-stats.repository';
import { MonitoringHourlyStatsRepository } from './repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from './repositories/error-log.repository';

/**
 * 业务监控模块 (Business Layer)
 *
 * 统一管理消息处理全链路的监控体系：
 * - services/tracking/     采集写入：消息生命周期追踪、Redis 实时计数
 * - services/dashboard/    Dashboard 查询与系统监控接口编排
 * - services/alerts/       业务指标告警编排
 * - services/projections/  小时聚合数据重建与投影
 * - services/maintenance/  聚合维护与后台管理操作
 * - services/cleanup/      数据清理：定时清理过期记录
 */
@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    forwardRef(() => MessageModule),
    BizMessageModule,
    AnalyticsModule,
    NotificationModule,
    ObservabilityModule,
    UserModule,
    HostingConfigModule,
  ],
  controllers: [AnalyticsController, MonitoringController],
  providers: [
    // Monitoring Repositories (biz message repos come from BizMessageModule)
    MonitoringRecordRepository,
    MonitoringDailyStatsRepository,
    MonitoringHourlyStatsRepository,
    MonitoringErrorLogRepository,
    // Tracking
    MonitoringCacheService,
    MessageTrackingService,
    // Dashboard / Alerts / Maintenance / Projections
    AnalyticsDashboardService,
    AnalyticsQueryService,
    AnalyticsMaintenanceService,
    DailyStatsAggregatorService,
    HourlyStatsAggregatorService,
    AnalyticsAlertService,
    // Cleanup
    DataCleanupService,
  ],
  exports: [
    MessageTrackingService,
    MonitoringCacheService,
    AnalyticsDashboardService,
    AnalyticsQueryService,
    AnalyticsMaintenanceService,
    DailyStatsAggregatorService,
    HourlyStatsAggregatorService,
    AnalyticsAlertService,
    DataCleanupService,
  ],
})
export class MonitoringModule {}
