import { Module, Global, forwardRef } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MessageModule } from '@wecom/message/message.module';
import { BizMessageModule } from '@biz/message/message.module';
import { FeishuModule } from '@/infra/feishu/feishu.module';
import { UserModule } from '../user/user.module';
import { HostingConfigModule } from '../hosting-config/hosting-config.module';

// Tracking (采集写入)
import { MessageTrackingService } from './services/tracking/message-tracking.service';
import { MonitoringCacheService } from './services/tracking/monitoring-cache.service';

// Analytics (聚合分析)
import { AnalyticsDashboardService } from './services/analytics/analytics-dashboard.service';
import { AnalyticsQueryService } from './services/analytics/analytics-query.service';
import { AnalyticsMaintenanceService } from './services/analytics/analytics-maintenance.service';
import { HourlyStatsAggregatorService } from './services/analytics/hourly-stats-aggregator.service';
import { AnalyticsAlertService } from './services/analytics/analytics-alert.service';

// Cleanup (数据清理)
import { DataCleanupService } from './services/cleanup/data-cleanup.service';

// Controllers
import { AnalyticsController, WebController } from './monitoring.controller';

// Repositories
import { MonitoringRecordRepository } from './repositories/record.repository';
import { MonitoringHourlyStatsRepository } from './repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from './repositories/error-log.repository';

/**
 * 业务监控模块 (Business Layer)
 *
 * 统一管理消息处理全链路的监控体系：
 * - services/tracking/     采集写入：消息生命周期追踪、Redis 实时计数
 * - services/analytics/    聚合分析：Dashboard 数据、趋势计算、业务告警
 * - services/cleanup/      数据清理：定时清理过期记录
 */
@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    forwardRef(() => MessageModule),
    BizMessageModule,
    FeishuModule,
    UserModule,
    HostingConfigModule,
  ],
  controllers: [AnalyticsController, WebController],
  providers: [
    // Monitoring Repositories (biz message repos come from BizMessageModule)
    MonitoringRecordRepository,
    MonitoringHourlyStatsRepository,
    MonitoringErrorLogRepository,
    // Tracking
    MonitoringCacheService,
    MessageTrackingService,
    // Analytics
    AnalyticsDashboardService,
    AnalyticsQueryService,
    AnalyticsMaintenanceService,
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
    HourlyStatsAggregatorService,
    AnalyticsAlertService,
    DataCleanupService,
  ],
})
export class MonitoringModule {}
