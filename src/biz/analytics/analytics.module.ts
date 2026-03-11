import { Module } from '@nestjs/common';
import {
  MonitoringRepository,
  MonitoringHourlyStatsRepository,
  MonitoringErrorLogRepository,
} from './repositories';
import { AnalyticsService, HourlyStatsAggregatorService, AnalyticsAlertService } from './services';
import { AnalyticsController } from './analytics.controller';
import { FeishuModule } from '@/core/feishu/feishu.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [FeishuModule, UserModule],
  controllers: [AnalyticsController],
  providers: [
    // repositories
    MonitoringRepository,
    MonitoringHourlyStatsRepository,
    MonitoringErrorLogRepository,
    // services
    AnalyticsService,
    HourlyStatsAggregatorService,
    AnalyticsAlertService,
  ],
  exports: [AnalyticsService, HourlyStatsAggregatorService, AnalyticsAlertService],
})
export class AnalyticsModule {}
