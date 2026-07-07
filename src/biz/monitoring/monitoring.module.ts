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
import { ReengagementTrackingService } from './services/tracking/reengagement-tracking.service';

// Dashboard / Alerts / Maintenance / Projections (应用编排)
import { AnalyticsDashboardService } from './services/dashboard/analytics-dashboard.service';
import { AnalyticsQueryService } from './services/dashboard/analytics-query.service';
import { ReengagementQueryService } from './services/dashboard/reengagement-query.service';
import { AnalyticsMaintenanceService } from './services/maintenance/analytics-maintenance.service';
import { MonitoringProbeService } from './services/maintenance/monitoring-probe.service';
import { DailyStatsAggregatorService } from './services/projections/daily-stats-aggregator.service';
import { HourlyStatsAggregatorService } from './services/projections/hourly-stats-aggregator.service';
import { AnalyticsAlertService } from './services/alerts/analytics-alert.service';
import { ExtractionAccuracyService } from './services/dashboard/extraction-accuracy.service';

// Cleanup (数据清理)
import { DataCleanupService } from './services/cleanup/data-cleanup.service';

// Controllers
import { AnalyticsController, MonitoringController } from './monitoring.controller';

// Repositories
import { MonitoringRecordRepository } from './repositories/record.repository';
import { AgentExecutionEventRepository } from './repositories/agent-execution-event.repository';
import { MonitoringDailyStatsRepository } from './repositories/daily-stats.repository';
import { MonitoringHourlyStatsRepository } from './repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from './repositories/error-log.repository';
import { ExtractionAccuracyRepository } from './repositories/extraction-accuracy.repository';
import { ReengagementTouchRepository } from './repositories/reengagement-touch.repository';
import { AlertLogPersisterService } from './services/tracking/alert-log.persister';
import { ALERT_LOG_PERSISTER } from '@notification/types/alert-log-persister.interface';
import { AgentExecutionEventPersisterService } from './services/tracking/agent-execution-event.persister';
import { AGENT_EVENT_PERSISTER } from '@observability/persistence/agent-event-persister.interface';

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
    AgentExecutionEventRepository,
    MonitoringDailyStatsRepository,
    MonitoringHourlyStatsRepository,
    MonitoringErrorLogRepository,
    ExtractionAccuracyRepository,
    ReengagementTouchRepository,
    // Tracking
    MonitoringCacheService,
    MessageTrackingService,
    ReengagementTrackingService,
    // 告警持久化：把 AlertNotifierService 的告警写入 monitoring_error_logs。
    // 接口 token 在 @Global 模块导出，AlertNotifierService（notification 层）
    // 通过 @Optional() @Inject(ALERT_LOG_PERSISTER) 解析，保持 notification 对 biz 零依赖。
    AlertLogPersisterService,
    { provide: ALERT_LOG_PERSISTER, useExisting: AlertLogPersisterService },
    // Agent 执行事件持久化：observability 定义 token，monitoring 实现写表。
    AgentExecutionEventPersisterService,
    { provide: AGENT_EVENT_PERSISTER, useExisting: AgentExecutionEventPersisterService },
    // Dashboard / Alerts / Maintenance / Projections
    AnalyticsDashboardService,
    AnalyticsQueryService,
    ReengagementQueryService,
    AnalyticsMaintenanceService,
    MonitoringProbeService,
    DailyStatsAggregatorService,
    HourlyStatsAggregatorService,
    AnalyticsAlertService,
    ExtractionAccuracyService,
    // Cleanup
    DataCleanupService,
  ],
  exports: [
    MessageTrackingService,
    ReengagementTrackingService,
    MonitoringCacheService,
    AnalyticsDashboardService,
    AnalyticsQueryService,
    AnalyticsMaintenanceService,
    MonitoringProbeService,
    DailyStatsAggregatorService,
    HourlyStatsAggregatorService,
    AnalyticsAlertService,
    DataCleanupService,
    ALERT_LOG_PERSISTER,
    AGENT_EVENT_PERSISTER,
  ],
})
export class MonitoringModule {}
