import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { HourlyStatsAggregatorService } from './services/hourly-stats-aggregator.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsAlertService } from './services/analytics-alert.service';
import { FeishuModule } from '@/core/feishu/feishu.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [FeishuModule, UserModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, HourlyStatsAggregatorService, AnalyticsAlertService],
  exports: [AnalyticsService, HourlyStatsAggregatorService, AnalyticsAlertService],
})
export class AnalyticsModule {}
