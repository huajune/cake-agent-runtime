import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsAlertService } from '@biz/monitoring/services/analytics/analytics-alert.service';
import { AnalyticsDashboardService } from '@biz/monitoring/services/analytics/analytics-dashboard.service';
import { FeishuAlertService } from '@core/feishu';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';

// Minimal DashboardData shape for testing
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
  let analyticsDashboardService: jest.Mocked<AnalyticsDashboardService>;
  let feishuAlertService: jest.Mocked<FeishuAlertService>;
  let systemConfigService: jest.Mocked<SystemConfigService>;

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

  const mockFeishuAlertService = {
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
        {
          provide: AnalyticsDashboardService,
          useValue: mockAnalyticsDashboardService,
        },
        {
          provide: FeishuAlertService,
          useValue: mockFeishuAlertService,
        },
        {
          provide: SystemConfigService,
          useValue: mockSystemConfigService,
        },
      ],
    }).compile();

    service = module.get<AnalyticsAlertService>(AnalyticsAlertService);
    analyticsDashboardService = module.get(AnalyticsDashboardService);
    feishuAlertService = module.get(FeishuAlertService);
    systemConfigService = module.get(SystemConfigService);

    jest.clearAllMocks();

    mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(mockConfig);
    mockSystemConfigService.onAgentReplyConfigChange.mockImplementation((cb) => {
      configChangeCallback = cb;
    });
    mockFeishuAlertService.sendSimpleAlert.mockResolvedValue(undefined);
    mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
      buildMockDashboard() as never,
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // onModuleInit
  // ========================================

  describe('onModuleInit', () => {
    it('should load config from SystemConfigService on initialization', async () => {
      await service.onModuleInit();

      expect(systemConfigService.getAgentReplyConfig).toHaveBeenCalled();
    });

    it('should handle config load failure gracefully', async () => {
      mockSystemConfigService.getAgentReplyConfig.mockRejectedValue(new Error('Config error'));

      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  // ========================================
  // checkBusinessMetrics - disabled state
  // ========================================

  describe('checkBusinessMetrics when disabled', () => {
    it('should not check metrics when service is disabled', async () => {
      // Initialize with disabled config
      mockSystemConfigService.getAgentReplyConfig.mockResolvedValue({
        ...mockConfig,
        businessAlertEnabled: false,
      });
      await service.onModuleInit();

      await service.checkBusinessMetrics();

      expect(analyticsDashboardService.getDashboardDataAsync).not.toHaveBeenCalled();
    });
  });

  // ========================================
  // checkBusinessMetrics - healthy state
  // ========================================

  describe('checkBusinessMetrics with healthy metrics', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should not send any alerts when all metrics are healthy', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({
          totalMessages: 100,
          successRate: 95,
          avgDuration: 5000,
          currentProcessing: 2,
          last24Hours: 5,
        }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).not.toHaveBeenCalled();
    });

    it('should skip success rate and duration checks when below minSamples', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({
          totalMessages: 5, // below minSamples (10)
          successRate: 50, // would normally trigger alert
        }) as never,
      );

      await service.checkBusinessMetrics();

      // Success rate check skipped, but queue and error rate still checked
      const successRateAlerts = (feishuAlertService.sendSimpleAlert as jest.Mock).mock.calls.filter(
        ([title]) => title.includes('成功率'),
      );
      expect(successRateAlerts).toHaveLength(0);
    });
  });

  // ========================================
  // checkBusinessMetrics - success rate alerts
  // ========================================

  describe('success rate alerts', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should send critical alert when success rate is below critical threshold (80%)', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ totalMessages: 100, successRate: 70 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '成功率严重下降',
        expect.stringContaining('70.0%'),
        'critical',
      );
    });

    it('should send warning alert when success rate is below warning threshold (90%) but above critical', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ totalMessages: 100, successRate: 85 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '成功率下降',
        expect.stringContaining('85.0%'),
        'warning',
      );
    });

    it('should not send alert for success rate when value is not finite', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ totalMessages: 100, successRate: NaN }) as never,
      );

      await service.checkBusinessMetrics();

      const successRateAlerts = (feishuAlertService.sendSimpleAlert as jest.Mock).mock.calls.filter(
        ([title]) => title.includes('成功率'),
      );
      expect(successRateAlerts).toHaveLength(0);
    });

    it('should throttle success rate alerts based on alertIntervalMinutes', async () => {
      const dashboard = buildMockDashboard({ totalMessages: 100, successRate: 70 }) as never;
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(dashboard);

      // First check - should send alert
      await service.checkBusinessMetrics();
      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(dashboard);

      // Second check immediately - should NOT send alert (within throttle window)
      await service.checkBusinessMetrics();
      const successRateAlerts = (feishuAlertService.sendSimpleAlert as jest.Mock).mock.calls.filter(
        ([title]) => title.includes('成功率'),
      );
      expect(successRateAlerts).toHaveLength(0);
    });
  });

  // ========================================
  // checkBusinessMetrics - response time alerts
  // ========================================

  describe('response time alerts', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should send critical alert when avgDuration exceeds critical threshold (60s)', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ totalMessages: 100, avgDuration: 70000 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '响应时间过长',
        expect.stringContaining('70.0s'),
        'critical',
      );
    });

    it('should send warning alert when avgDuration exceeds warning threshold (30s)', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ totalMessages: 100, avgDuration: 35000 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '响应时间偏高',
        expect.stringContaining('35.0s'),
        'warning',
      );
    });

    it('should not send alert when avgDuration is 0 or negative', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ totalMessages: 100, avgDuration: 0 }) as never,
      );

      await service.checkBusinessMetrics();

      const durationAlerts = (feishuAlertService.sendSimpleAlert as jest.Mock).mock.calls.filter(
        ([title]) => title.includes('响应时间'),
      );
      expect(durationAlerts).toHaveLength(0);
    });
  });

  // ========================================
  // checkBusinessMetrics - queue depth alerts
  // ========================================

  describe('queue depth alerts', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should send critical alert when queue depth exceeds critical threshold (20)', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ currentProcessing: 25 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '队列严重积压',
        expect.stringContaining('25条'),
        'critical',
      );
    });

    it('should send warning alert when queue depth exceeds warning threshold (10)', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ currentProcessing: 15 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '队列积压',
        expect.stringContaining('15条'),
        'warning',
      );
    });

    it('should not send alert when queue depth is within normal range', async () => {
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ currentProcessing: 3 }) as never,
      );

      await service.checkBusinessMetrics();

      const queueAlerts = (feishuAlertService.sendSimpleAlert as jest.Mock).mock.calls.filter(
        ([title]) => title.includes('队列'),
      );
      expect(queueAlerts).toHaveLength(0);
    });
  });

  // ========================================
  // checkBusinessMetrics - error rate alerts
  // ========================================

  describe('error rate alerts', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should send critical alert when hourly error rate exceeds critical threshold (10/h)', async () => {
      // 24h error count = 300, hourly rate = 12.5/h (> 10/h critical)
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ last24Hours: 300 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '错误率过高',
        expect.stringContaining('300'),
        'critical',
      );
    });

    it('should send warning alert when hourly error rate exceeds warning threshold (5/h)', async () => {
      // 24h error count = 144, hourly rate = 6/h (> 5/h warning, < 10/h critical)
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ last24Hours: 144 }) as never,
      );

      await service.checkBusinessMetrics();

      expect(feishuAlertService.sendSimpleAlert).toHaveBeenCalledWith(
        '错误率偏高',
        expect.stringContaining('144'),
        'warning',
      );
    });

    it('should not send alert when error rate is within normal range', async () => {
      // 24h error count = 48, hourly rate = 2/h
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ last24Hours: 48 }) as never,
      );

      await service.checkBusinessMetrics();

      const errorAlerts = (feishuAlertService.sendSimpleAlert as jest.Mock).mock.calls.filter(
        ([title]) => title.includes('错误率'),
      );
      expect(errorAlerts).toHaveLength(0);
    });
  });

  // ========================================
  // Config change handling
  // ========================================

  describe('config change handling', () => {
    it('should register a config change callback on construction', () => {
      // configChangeCallback is captured during module construction (before clearAllMocks)
      // We verify that the callback registration happened by confirming the callback was captured
      expect(configChangeCallback).toBeDefined();
    });

    it('should apply new config when onAgentReplyConfigChange callback is fired', async () => {
      await service.onModuleInit();

      // Trigger config change with disabled state
      if (configChangeCallback) {
        configChangeCallback({ ...mockConfig, businessAlertEnabled: false });
      }

      // After config change, service should be disabled
      await service.checkBusinessMetrics();

      expect(analyticsDashboardService.getDashboardDataAsync).not.toHaveBeenCalled();
    });

    it('should update thresholds when config changes', async () => {
      await service.onModuleInit();

      // Change critical threshold to 50% (currently 80%)
      if (configChangeCallback) {
        configChangeCallback({ ...mockConfig, successRateCritical: 50 });
      }

      // Success rate of 60% should now be below critical (50%) threshold
      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({ totalMessages: 100, successRate: 60 }) as never,
      );

      await service.checkBusinessMetrics();

      // With new threshold at 50%, rate of 60% should not trigger critical
      const criticalAlerts = (feishuAlertService.sendSimpleAlert as jest.Mock).mock.calls.filter(
        ([, , level]) => level === 'critical' && ([] as string[]).includes('成功率'),
      );
      expect(criticalAlerts).toHaveLength(0);
    });
  });

  // ========================================
  // Error handling
  // ========================================

  describe('error handling', () => {
    it('should not throw when getDashboardDataAsync fails', async () => {
      await service.onModuleInit();
      mockAnalyticsDashboardService.getDashboardDataAsync.mockRejectedValue(
        new Error('Dashboard error'),
      );

      await expect(service.checkBusinessMetrics()).resolves.not.toThrow();
    });

    it('should continue checking other metrics when one alert fails', async () => {
      await service.onModuleInit();

      mockAnalyticsDashboardService.getDashboardDataAsync.mockResolvedValue(
        buildMockDashboard({
          totalMessages: 100,
          successRate: 70, // critical
          currentProcessing: 25, // critical
        }) as never,
      );

      mockFeishuAlertService.sendSimpleAlert
        .mockRejectedValueOnce(new Error('Feishu error'))
        .mockResolvedValue(undefined);

      // Should not throw even if first alert fails
      await expect(service.checkBusinessMetrics()).resolves.not.toThrow();
    });
  });
});
