import { ConversionAnalyticsController } from '@biz/conversion-analytics/conversion-analytics.controller';
import { ConversionAnalyticsService } from '@biz/conversion-analytics/conversion-analytics.service';

describe('ConversionAnalyticsController', () => {
  const buildController = () => {
    const service = {
      getKpis: jest.fn().mockResolvedValue({ endpoint: 'kpis' }),
      getFunnel: jest.fn().mockResolvedValue({ endpoint: 'funnel' }),
      getTrends: jest.fn().mockResolvedValue({ endpoint: 'trends' }),
      getBots: jest.fn().mockResolvedValue({ endpoint: 'bots' }),
      getHandoff: jest.fn().mockResolvedValue({ endpoint: 'handoff' }),
    };

    return {
      controller: new ConversionAnalyticsController(
        service as unknown as ConversionAnalyticsService,
      ),
      service,
    };
  };

  it('normalizes KPI query params before delegating to the service', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.getKpis(
        'last30',
        ['北区, 南区', '东区'],
        'wecom, private',
        ' corp-1 ',
        'cohort',
        '14',
      ),
    ).resolves.toEqual({ endpoint: 'kpis' });

    expect(service.getKpis).toHaveBeenCalledWith(
      {
        range: 'month',
        groups: ['北区', '南区', '东区'],
        channels: ['wecom', 'private'],
        corpId: 'corp-1',
        maturityDays: 14,
      },
      'cohort',
    );
  });

  it('uses safe defaults for invalid funnel cohort, range, and mode', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.getFunnel('unknown', 'future', '', '', '   ', 'invalid'),
    ).resolves.toEqual({
      endpoint: 'funnel',
    });

    expect(service.getFunnel).toHaveBeenCalledWith(
      'friend_added',
      {
        range: 'week',
        groups: [],
        channels: [],
        corpId: undefined,
        maturityDays: 7,
      },
      'cohort',
    );
  });

  it('normalizes all reporting endpoints consistently', async () => {
    const { controller, service } = buildController();

    await expect(
      controller.getTrends('60d', 'A,B', ['x', 'y'], 'corp-2', 'period'),
    ).resolves.toEqual({
      endpoint: 'trends',
    });
    await expect(controller.getBots('90d', 'A', 'x,y', 'corp-3', 'cohort')).resolves.toEqual({
      endpoint: 'bots',
    });
    await expect(controller.getHandoff('180d', ['A,B'], 'corp-4')).resolves.toEqual({
      endpoint: 'handoff',
    });

    expect(service.getTrends).toHaveBeenCalledWith(
      { range: 'twoMonths', groups: ['A', 'B'], channels: ['x', 'y'], corpId: 'corp-2' },
      'period',
    );
    expect(service.getBots).toHaveBeenCalledWith(
      {
        range: 'threeMonths',
        groups: ['A'],
        channels: ['x', 'y'],
        corpId: 'corp-3',
        maturityDays: 7,
      },
      'cohort',
    );
    expect(service.getHandoff).toHaveBeenCalledWith({
      range: 'sixMonths',
      groups: ['A', 'B'],
      channels: [],
      corpId: 'corp-4',
    });
  });
});
