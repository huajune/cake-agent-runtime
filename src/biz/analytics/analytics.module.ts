import { Module } from '@nestjs/common';
import { AnalyticsService, HourlyStatsAggregatorService, AnalyticsAlertService } from './services';
import { AnalyticsController } from './analytics.controller';
import { FeishuModule } from '@/core/feishu/feishu.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [FeishuModule, UserModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, HourlyStatsAggregatorService, AnalyticsAlertService],
  exports: [AnalyticsService, HourlyStatsAggregatorService, AnalyticsAlertService],
})
export class AnalyticsModule {}
