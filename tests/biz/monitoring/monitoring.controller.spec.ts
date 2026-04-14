import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from '@biz/monitoring/monitoring.controller';
import { AnalyticsDashboardService } from '@biz/monitoring/services/dashboard/analytics-dashboard.service';
import { AnalyticsQueryService } from '@biz/monitoring/services/dashboard/analytics-query.service';
import { AnalyticsMaintenanceService } from '@biz/monitoring/services/maintenance/analytics-maintenance.service';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let dashboardService: AnalyticsDashboardService;
  let queryService: AnalyticsQueryService;
  let maintenanceService: AnalyticsMaintenanceService;

  const mockDashboardService = {
    getDashboardOverviewAsync: jest.fn(),
  };

  const mockQueryService = {
    getSystemMonitoringAsync: jest.fn(),
    getTrendsDataAsync: jest.fn(),
    getMetricsDataAsync: jest.fn(),
    getTodayUsersFromDatabase: jest.fn(),
    getUsersByDate: jest.fn(),
    getUserTrend: jest.fn(),
    getRecentDetailRecords: jest.fn(),
    getSystemInfo: jest.fn(),
  };

  const mockMaintenanceService = {
    clearAllDataAsync: jest.fn(),
    clearCacheAsync: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        { provide: AnalyticsDashboardService, useValue: mockDashboardService },
        { provide: AnalyticsQueryService, useValue: mockQueryService },
        { provide: AnalyticsMaintenanceService, useValue: mockMaintenanceService },
      ],
    }).compile();

    controller = module.get<AnalyticsController>(AnalyticsController);
    dashboardService = module.get<AnalyticsDashboardService>(AnalyticsDashboardService);
    queryService = module.get<AnalyticsQueryService>(AnalyticsQueryService);
    maintenanceService = module.get<AnalyticsMaintenanceService>(AnalyticsMaintenanceService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getDashboardOverview', () => {
    it('should use "today" as default time range when no range provided', async () => {
      const mockResult = { totalMessages: 100, activeUsers: 20 };
      mockDashboardService.getDashboardOverviewAsync.mockResolvedValue(mockResult);

      const result = await controller.getDashboardOverview();

      expect(dashboardService.getDashboardOverviewAsync).toHaveBeenCalledWith('today');
      expect(result).toEqual(mockResult);
    });

    it('should pass provided range to dashboardService', async () => {
      const mockResult = { totalMessages: 500 };
      mockDashboardService.getDashboardOverviewAsync.mockResolvedValue(mockResult);

      const result = await controller.getDashboardOverview('week');

      expect(dashboardService.getDashboardOverviewAsync).toHaveBeenCalledWith('week');
      expect(result).toEqual(mockResult);
    });

    it('should support "month" range', async () => {
      mockDashboardService.getDashboardOverviewAsync.mockResolvedValue({});

      await controller.getDashboardOverview('month');

      expect(dashboardService.getDashboardOverviewAsync).toHaveBeenCalledWith('month');
    });

    it('should propagate errors from dashboardService', async () => {
      mockDashboardService.getDashboardOverviewAsync.mockRejectedValue(new Error('DB error'));

      await expect(controller.getDashboardOverview()).rejects.toThrow('DB error');
    });
  });

  describe('getSystemMonitoring', () => {
    it('should return system monitoring data', async () => {
      const mockResult = { cpu: '10%', memory: '60%', uptime: 3600 };
      mockQueryService.getSystemMonitoringAsync.mockResolvedValue(mockResult);

      const result = await controller.getSystemMonitoring();

      expect(queryService.getSystemMonitoringAsync).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('should propagate errors from queryService', async () => {
      mockQueryService.getSystemMonitoringAsync.mockRejectedValue(new Error('Monitoring error'));

      await expect(controller.getSystemMonitoring()).rejects.toThrow('Monitoring error');
    });
  });

  describe('getTrends', () => {
    it('should use "today" as default range when not provided', async () => {
      const mockResult = [{ time: '10:00', count: 5 }];
      mockQueryService.getTrendsDataAsync.mockResolvedValue(mockResult);

      const result = await controller.getTrends();

      expect(queryService.getTrendsDataAsync).toHaveBeenCalledWith('today');
      expect(result).toEqual(mockResult);
    });

    it('should pass provided range to queryService', async () => {
      mockQueryService.getTrendsDataAsync.mockResolvedValue([]);

      await controller.getTrends('week');

      expect(queryService.getTrendsDataAsync).toHaveBeenCalledWith('week');
    });
  });

  describe('getMetrics', () => {
    it('should return metrics data', async () => {
      const mockMetrics = {
        totalMessages: 1000,
        successRate: 0.99,
        avgResponseTime: 2500,
      };
      mockQueryService.getMetricsDataAsync.mockResolvedValue(mockMetrics);

      const result = await controller.getMetrics();

      expect(queryService.getMetricsDataAsync).toHaveBeenCalled();
      expect(result).toEqual(mockMetrics);
    });
  });

  describe('getUsersByDate', () => {
    it('should call getTodayUsersFromDatabase when no date provided', async () => {
      const mockResult = [{ userId: 'u-1', name: 'User 1' }];
      mockQueryService.getTodayUsersFromDatabase.mockResolvedValue(mockResult);

      const result = await controller.getUsersByDate();

      expect(queryService.getTodayUsersFromDatabase).toHaveBeenCalled();
      expect(queryService.getUsersByDate).not.toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('should call getUsersByDate when date is provided', async () => {
      const date = '2024-01-15';
      const mockResult = [{ userId: 'u-2', name: 'User 2' }];
      mockQueryService.getUsersByDate.mockResolvedValue(mockResult);

      const result = await controller.getUsersByDate(date);

      expect(queryService.getUsersByDate).toHaveBeenCalledWith(date);
      expect(queryService.getTodayUsersFromDatabase).not.toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });
  });

  describe('getUserTrend', () => {
    it('should return user trend data', async () => {
      const mockResult = [{ date: '2024-01-01', count: 10 }];
      mockQueryService.getUserTrend.mockResolvedValue(mockResult);

      const result = await controller.getUserTrend();

      expect(queryService.getUserTrend).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });
  });

  describe('getRecentMessages', () => {
    it('should call getRecentDetailRecords with default limit 50', async () => {
      const mockResult = [{ messageId: 'msg-1', content: 'Hello' }];
      mockQueryService.getRecentDetailRecords.mockResolvedValue(mockResult);

      const result = await controller.getRecentMessages();

      expect(queryService.getRecentDetailRecords).toHaveBeenCalledWith(50);
      expect(result).toEqual(mockResult);
    });

    it('should parse limit string to integer', async () => {
      mockQueryService.getRecentDetailRecords.mockResolvedValue([]);

      await controller.getRecentMessages('20');

      expect(queryService.getRecentDetailRecords).toHaveBeenCalledWith(20);
    });

    it('should use limit 100 when specified', async () => {
      mockQueryService.getRecentDetailRecords.mockResolvedValue([]);

      await controller.getRecentMessages('100');

      expect(queryService.getRecentDetailRecords).toHaveBeenCalledWith(100);
    });
  });

  describe('getSystemInfo', () => {
    it('should return system information', async () => {
      const mockInfo = { version: '1.2.3', environment: 'production', uptime: 86400 };
      mockQueryService.getSystemInfo.mockResolvedValue(mockInfo);

      const result = await controller.getSystemInfo();

      expect(queryService.getSystemInfo).toHaveBeenCalled();
      expect(result).toEqual(mockInfo);
    });
  });

  describe('clearAllData', () => {
    it('should clear all data and return success response', async () => {
      mockMaintenanceService.clearAllDataAsync.mockResolvedValue(undefined);

      const result = await controller.clearAllData();

      expect(maintenanceService.clearAllDataAsync).toHaveBeenCalled();
      expect(result).toEqual({ success: true, message: '监控统计数据已清空' });
    });

    it('should propagate errors from maintenanceService', async () => {
      mockMaintenanceService.clearAllDataAsync.mockRejectedValue(new Error('Clear failed'));

      await expect(controller.clearAllData()).rejects.toThrow('Clear failed');
    });
  });

  describe('clearCache', () => {
    it('should use "all" as default cache type when not provided', async () => {
      mockMaintenanceService.clearCacheAsync.mockResolvedValue(undefined);

      const result = await controller.clearCache();

      expect(maintenanceService.clearCacheAsync).toHaveBeenCalledWith('all');
      expect(result).toEqual({ success: true, message: '缓存 [all] 已清除' });
    });

    it('should clear metrics cache when type is "metrics"', async () => {
      mockMaintenanceService.clearCacheAsync.mockResolvedValue(undefined);

      const result = await controller.clearCache('metrics');

      expect(maintenanceService.clearCacheAsync).toHaveBeenCalledWith('metrics');
      expect(result).toEqual({ success: true, message: '缓存 [metrics] 已清除' });
    });

    it('should clear history cache when type is "history"', async () => {
      mockMaintenanceService.clearCacheAsync.mockResolvedValue(undefined);

      const result = await controller.clearCache('history');

      expect(maintenanceService.clearCacheAsync).toHaveBeenCalledWith('history');
      expect(result).toEqual({ success: true, message: '缓存 [history] 已清除' });
    });

    it('should clear agent cache when type is "agent"', async () => {
      mockMaintenanceService.clearCacheAsync.mockResolvedValue(undefined);

      const result = await controller.clearCache('agent');

      expect(maintenanceService.clearCacheAsync).toHaveBeenCalledWith('agent');
      expect(result).toEqual({ success: true, message: '缓存 [agent] 已清除' });
    });

    it('should propagate errors from maintenanceService', async () => {
      mockMaintenanceService.clearCacheAsync.mockRejectedValue(new Error('Cache clear failed'));

      await expect(controller.clearCache('all')).rejects.toThrow('Cache clear failed');
    });
  });
});
