import { Module } from '@nestjs/common';
import { ConversionAnalyticsController } from './conversion-analytics.controller';
import { ConversionAnalyticsService } from './conversion-analytics.service';
import { OpsEventsAnalyticsRepository } from './repositories/ops-events-analytics.repository';

@Module({
  controllers: [ConversionAnalyticsController],
  providers: [ConversionAnalyticsService, OpsEventsAnalyticsRepository],
  exports: [ConversionAnalyticsService],
})
export class ConversionAnalyticsModule {}
