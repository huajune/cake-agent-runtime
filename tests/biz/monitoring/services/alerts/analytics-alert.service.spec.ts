import { Test, TestingModule } from '@nestjs/testing';
import { BusinessMetricRuleEngine } from '@analytics/rules/business-metric-rule.engine';
import { AnalyticsAlertService } from '@biz/monitoring/services/alerts/analytics-alert.service';
import { AnalyticsDashboardService } from '@biz/monitoring/services/dashboard/analytics-dashboard.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';

const buildMockDashboard = (
  overrides: {
    totalMessages?: number;
    successRate?: number;
    avgDuration?: number;
    currentProcessing?: number;
    last24Hours?: number;
  } = {},
) => ({
  overview: {
    totalMessages: overrides.totalMessages ?? 100,
    successRate: overrides.successRate ?? 95,
    avgDuration: overrides.avgDuration ?? 5000,
    successCount: 95,
    failureCount: 5,
    activeChats: 20,
  },
  queue: {
    currentProcessing: overrides.currentProcessing ?? 2,
    peakProcessing: 5,
    avgQueueDuration: 200,
  },
  alertsSummary: {
    last24Hours: overrides.last24Hours ?? 3,
    total: 5,
    lastHour: 1,
    byType: [],
  },
});

describe('AnalyticsAlertService', () => {
  let service: AnalyticsAlertService;

  const mockConfig = {
    businessAlertEnabled: true,
    minSamplesForAlert: 10,
    alertIntervalMinutes: 30,
    successRateCritical: 80,
    avgDurationCritical: 60000,
    queueDepthCritical: 20,
    errorRateCritical: 10,
  };

  const mockAnalyticsDashboardService = {
    getDashboardDataAsync: jest.fn(),
  };

  const mockAlertService = {
    sendSimpleAlert: jest.fn(),
  };

  let configChangeCallback: ((config: typeof mockConfig) => void) | undefined;

  const mockSystemConfigService = {
    getAgentReplyConfig: jest.fn().mockResolvedValue(mockConfig),
    onAgentReplyConfigChange: jest.fn((cb) => {
      configChangeCallback = cb;
    }),
  };

  beforeEach(async () => {
    configChangeCallback = undefined;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsAlertService,
        BusinessMetricRuleEngine,
        { provide: AnalyticsDashboardService, useValue: mockAnalyticsDashboardService },
        { provide: AlertNotifierService, useValue: mockAlertService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    }).compile();

    service = module.get(AnalyticsAlertService);
    jest.clearAllMocks();
    mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(mockConfig);
    mockSystemConfigService.onAgentReplyConfigChange.mockImplementation((cb) => {
      configChangeCallback = cb;
    });
    mockAlertService.sendSimpleAlert.mockResolvedValue(undefined);
    mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(buildMockDashboard());
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('loads config from SystemConfigService on init', async () => {
    await service.onModuleInit();
    expect(mockSystemConfigService.getAgentReplyConfig).toHaveBeenCalled();
  });

  it('does not alert when disabled by config', async () => {
    mockSystemConfigService.getAgentReplyConfig.mockResolvedValue({
      ...mockConfig,
      businessAlertEnabled: false,
    });

    await service.onModuleInit();
    await service.checkBusinessMetrics();

    expect(mockAnalyticsDashboardService.getDashboardDataAsync).not.toHaveBeenCalled();
    expect(mockAlertService.sendSimpleAlert).not.toHaveBeenCalled();
  });

  it('sends a critical alert when success rate drops below threshold', async () => {
    mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
      buildMockDashboard({ totalMessages: 100, successRate: 70 }),
    );

    await service.onModuleInit();
    await service.checkBusinessMetrics();

    expect(mockAlertService.sendSimpleAlert).toHaveBeenCalledWith(
      '成功率严重下降',
      expect.stringContaining('当前成功率: 70.0%'),
      'critical',
    );
  });

  it('sends a warning when queue depth is high but not critical', async () => {
    mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
      buildMockDashboard({ currentProcessing: 11 }),
    );

    await service.onModuleInit();
    await service.checkBusinessMetrics();

    expect(mockAlertService.sendSimpleAlert).toHaveBeenCalledWith(
      '队列积压',
      expect.stringContaining('当前队列深度: 11条'),
      'warning',
    );
  });

  it('applies config changes pushed from SystemConfigService', async () => {
    await service.onModuleInit();
    configChangeCallback?.({
      ...mockConfig,
      successRateCritical: 90,
    });
    mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
      buildMockDashboard({ totalMessages: 100, successRate: 85 }),
    );

    await service.checkBusinessMetrics();

    expect(mockAlertService.sendSimpleAlert).toHaveBeenCalledWith(
      '成功率严重下降',
      expect.stringContaining('阈值: 90%'),
      'critical',
    );
  });
});
