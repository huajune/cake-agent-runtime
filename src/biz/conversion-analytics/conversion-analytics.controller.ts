import { Controller, Get, Query } from '@nestjs/common';
import { ConversionAnalyticsService } from './conversion-analytics.service';
import {
  ConversionFilter,
  ConversionMetricMode,
  ConversionRange,
} from './types/conversion-analytics.types';

const RANGE_VALUES = new Set<ConversionRange>([
  'today',
  'week',
  'month',
  'twoMonths',
  'threeMonths',
  'sixMonths',
]);

@Controller('analytics/conversion')
export class ConversionAnalyticsController {
  constructor(private readonly service: ConversionAnalyticsService) {}

  @Get('kpis')
  async getKpis(
    @Query('range') range?: string,
    @Query('groups') groups?: string | string[],
    @Query('channel') channel?: string | string[],
    @Query('corpId') corpId?: string,
    @Query('mode') mode?: string,
  ) {
    return this.service.getKpis(this.toFilter(range, groups, channel, corpId), this.toMode(mode));
  }

  @Get('funnel')
  async getFunnel(
    @Query('cohort') cohort?: string,
    @Query('range') range?: string,
    @Query('groups') groups?: string | string[],
    @Query('channel') channel?: string | string[],
    @Query('corpId') corpId?: string,
    @Query('mode') mode?: string,
  ) {
    return this.service.getFunnel(
      cohort === 'booking' ? 'booking' : 'friend_added',
      this.toFilter(range, groups, channel, corpId),
      this.toMode(mode, 'cohort'),
    );
  }

  @Get('trends')
  async getTrends(
    @Query('range') range?: string,
    @Query('groups') groups?: string | string[],
    @Query('channel') channel?: string | string[],
    @Query('corpId') corpId?: string,
    @Query('mode') mode?: string,
  ) {
    return this.service.getTrends(this.toFilter(range, groups, channel, corpId), this.toMode(mode));
  }

  @Get('bots')
  async getBots(
    @Query('range') range?: string,
    @Query('groups') groups?: string | string[],
    @Query('channel') channel?: string | string[],
    @Query('corpId') corpId?: string,
    @Query('mode') mode?: string,
  ) {
    return this.service.getBots(this.toFilter(range, groups, channel, corpId), this.toMode(mode));
  }

  @Get('handoff')
  async getHandoff(
    @Query('range') range?: string,
    @Query('groups') groups?: string | string[],
    @Query('corpId') corpId?: string,
  ) {
    return this.service.getHandoff(this.toFilter(range, groups, undefined, corpId));
  }

  private toFilter(
    rawRange?: string,
    rawGroups?: string | string[],
    rawChannels?: string | string[],
    rawCorpId?: string,
  ): ConversionFilter {
    return {
      range: this.toRange(rawRange),
      groups: this.toList(rawGroups),
      channels: this.toList(rawChannels),
      corpId: rawCorpId?.trim() || undefined,
    };
  }

  private toRange(value?: string): ConversionRange {
    const normalized = this.normalizeRangeAlias(value);
    return RANGE_VALUES.has(normalized) ? normalized : 'week';
  }

  private toMode(value?: string, fallback: ConversionMetricMode = 'period'): ConversionMetricMode {
    return value === 'cohort' || value === 'period' ? value : fallback;
  }

  private normalizeRangeAlias(value?: string): ConversionRange {
    switch (value) {
      case 'last7':
      case '7d':
        return 'week';
      case 'last30':
      case '30d':
        return 'month';
      case 'last60':
      case '60d':
        return 'twoMonths';
      case 'last90':
      case '90d':
        return 'threeMonths';
      case 'last180':
      case '180d':
        return 'sixMonths';
      default:
        return (value || 'week') as ConversionRange;
    }
  }

  private toList(value?: string | string[]): string[] {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values
      .flatMap((item) => item.split(','))
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
