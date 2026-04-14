import { Global, Module } from '@nestjs/common';
import { AnalyticsMetricsService } from './metrics/analytics-metrics.service';
import { BusinessMetricRuleEngine } from './rules/business-metric-rule.engine';
import { AnalyticsTrendBuilderService } from './trends/analytics-trend-builder.service';

@Global()
@Module({
  providers: [AnalyticsMetricsService, AnalyticsTrendBuilderService, BusinessMetricRuleEngine],
  exports: [AnalyticsMetricsService, AnalyticsTrendBuilderService, BusinessMetricRuleEngine],
})
export class AnalyticsModule {}
