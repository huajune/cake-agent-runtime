import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GroupTaskSchedulerService } from '@biz/group-task/services/group-task-scheduler.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { CompletionService } from '@agent/completion.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { BrandRotationService } from '@biz/group-task/services/brand-rotation.service';
import { RedisService } from '@infra/redis/redis.service';
import { OrderGrabStrategy } from '@biz/group-task/strategies/order-grab.strategy';
import { PartTimeJobStrategy } from '@biz/group-task/strategies/part-time-job.strategy';
import { StoreManagerStrategy } from '@biz/group-task/strategies/store-manager.strategy';
import { WorkTipsStrategy } from '@biz/group-task/strategies/work-tips.strategy';
import { GroupTaskType, DEFAULT_GROUP_TASK_CONFIG } from '@biz/group-task/group-task.types';
import { NotificationStrategy } from '@biz/group-task/strategies/notification.strategy';

describe('GroupTaskSchedulerService', () => {
  let service: GroupTaskSchedulerService;
  let systemConfigService: jest.Mocked<SystemConfigService>;
  let notificationSenderService: jest.Mocked<NotificationSenderService>;
  let groupResolverService: jest.Mocked<GroupResolverService>;
  let redisClient: { set: jest.Mock; eval: jest.Mock };

  const mockStrategy: NotificationStrategy = {
    type: GroupTaskType.ORDER_GRAB,
    tagPrefix: '抢单群',
    needsAI: false,
    fetchData: jest.fn().mockResolvedValue([]),
    buildMessage: jest.fn().mockResolvedValue('test message'),
  } as unknown as NotificationStrategy;

  beforeEach(async () => {
    redisClient = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupTaskSchedulerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'GROUP_TASK_SEND_DELAY_MS') return '0';
              return defaultValue ?? '';
            }),
          } as unknown as ConfigService,
        },
        {
          provide: SystemConfigService,
          useValue: {
            getConfigValue: jest.fn(),
            setConfigValue: jest.fn(),
            getGroupTaskConfig: jest.fn(),
            updateGroupTaskConfig: jest.fn(),
          } as unknown as SystemConfigService,
        },
        {
          provide: CompletionService,
          useValue: {
            generateSimple: jest.fn().mockResolvedValue('AI generated text'),
          } as unknown as CompletionService,
        },
        {
          provide: RedisService,
          useValue: {
            getClient: jest.fn().mockReturnValue(redisClient),
          } as unknown as RedisService,
        },
        {
          provide: GroupResolverService,
          useValue: {
            resolveGroups: jest.fn().mockResolvedValue([]),
          } as unknown as GroupResolverService,
        },
        {
          provide: NotificationSenderService,
          useValue: {
            sendToGroup: jest.fn().mockResolvedValue(undefined),
            reportToFeishu: jest.fn().mockResolvedValue(undefined),
          } as unknown as NotificationSenderService,
        },
        {
          provide: BrandRotationService,
          useValue: {
            recordPushedBrand: jest.fn(),
          } as unknown as BrandRotationService,
        },
        {
          provide: OrderGrabStrategy,
          useValue: mockStrategy as unknown as OrderGrabStrategy,
        },
        {
          provide: PartTimeJobStrategy,
          useValue: {
            type: GroupTaskType.PART_TIME_JOB,
            tagPrefix: '兼职群',
            needsAI: false,
            fetchData: jest.fn().mockResolvedValue([]),
            buildMessage: jest.fn().mockResolvedValue('part time message'),
          } as unknown as PartTimeJobStrategy,
        },
        {
          provide: StoreManagerStrategy,
          useValue: {
            type: GroupTaskType.STORE_MANAGER,
            tagPrefix: '店长群',
            needsAI: false,
            fetchData: jest.fn().mockResolvedValue([]),
            buildMessage: jest.fn().mockResolvedValue('store manager message'),
          } as unknown as StoreManagerStrategy,
        },
        {
          provide: WorkTipsStrategy,
          useValue: {
            type: GroupTaskType.WORK_TIPS,
            tagPrefix: '工作群',
            needsAI: true,
            fetchData: jest.fn().mockResolvedValue([]),
            buildMessage: jest.fn().mockResolvedValue('work tips message'),
          } as unknown as WorkTipsStrategy,
        },
      ],
    }).compile();

    service = module.get<GroupTaskSchedulerService>(GroupTaskSchedulerService);
    systemConfigService = module.get(
      SystemConfigService,
    ) as jest.Mocked<SystemConfigService>;
    notificationSenderService = module.get(
      NotificationSenderService,
    ) as jest.Mocked<NotificationSenderService>;
    groupResolverService = module.get(
      GroupResolverService,
    ) as jest.Mocked<GroupResolverService>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getConfig', () => {
    it('should delegate to systemConfigService.getGroupTaskConfig', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue(DEFAULT_GROUP_TASK_CONFIG);

      const config = await service.getConfig();

      expect(config).toEqual(DEFAULT_GROUP_TASK_CONFIG);
      expect(systemConfigService.getGroupTaskConfig).toHaveBeenCalledTimes(1);
    });

    it('should return stored values', async () => {
      const storedConfig = { enabled: true, dryRun: false };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(storedConfig);

      const config = await service.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.dryRun).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should delegate to systemConfigService.updateGroupTaskConfig', async () => {
      const updated = { enabled: true, dryRun: true };
      (systemConfigService as jest.Mocked<SystemConfigService>).updateGroupTaskConfig =
        jest.fn().mockResolvedValue(updated);

      const result = await service.updateConfig({ enabled: true });

      expect(result).toEqual(updated);
      expect(systemConfigService.updateGroupTaskConfig).toHaveBeenCalledWith({ enabled: true });
    });
  });

  describe('getStrategy', () => {
    it('should return strategy for valid type', () => {
      expect(service.getStrategy(GroupTaskType.ORDER_GRAB)).toBeDefined();
    });

    it('should return null for unknown type', () => {
      expect(service.getStrategy('unknown' as GroupTaskType)).toBeNull();
    });
  });

  describe('executeTask', () => {
    it('should skip when disabled and not forced', async () => {
      const disabledConfig = { ...DEFAULT_GROUP_TASK_CONFIG, enabled: false };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(disabledConfig);

      await service.executeTask(mockStrategy);

      expect(groupResolverService.resolveGroups).not.toHaveBeenCalled();
      expect(notificationSenderService.sendToGroup).not.toHaveBeenCalled();
    });

    it('should run when forceEnabled even if disabled', async () => {
      const disabledConfig = { ...DEFAULT_GROUP_TASK_CONFIG, enabled: false };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(disabledConfig);
      groupResolverService.resolveGroups.mockResolvedValue([]);

      await service.executeTask(mockStrategy, { forceEnabled: true });

      expect(notificationSenderService.reportToFeishu).toHaveBeenCalled();
    });

    it('should respect config.dryRun when only forceEnabled (not forceSend)', async () => {
      const dryRunConfig = {
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: true,
        dryRun: true,
      };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(dryRunConfig);

      const mockGroup = {
        imRoomId: 'room-1',
        groupName: '测试群',
        city: '上海',
        tag: '抢单群',
        imBotId: 'bot-1',
        token: 'token-1',
        chatId: 'chat-1',
      };
      groupResolverService.resolveGroups.mockResolvedValue([mockGroup]);
      (mockStrategy.fetchData as jest.Mock).mockResolvedValue({
        hasData: true,
        payload: { orders: [] },
        summary: '测试',
      });
      (mockStrategy.buildMessage as jest.Mock).mockReturnValue('test message');

      await service.executeTask(mockStrategy, { forceEnabled: true });

      // forceEnabled=true, forceSend=false → dryRun 仍遵守 config
      expect(notificationSenderService.sendToGroup).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.sendToGroup.mock.calls[0][3]).toBe(true);

      expect(notificationSenderService.reportToFeishu).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.reportToFeishu.mock.calls[0][1]).toBe(true);
    });

    it('should bypass dryRun when forceSend=true', async () => {
      const dryRunConfig = {
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: true,
        dryRun: true,
      };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(dryRunConfig);

      const mockGroup = {
        imRoomId: 'room-1',
        groupName: '测试群',
        city: '上海',
        tag: '抢单群',
        imBotId: 'bot-1',
        token: 'token-1',
        chatId: 'chat-1',
      };
      groupResolverService.resolveGroups.mockResolvedValue([mockGroup]);
      (mockStrategy.fetchData as jest.Mock).mockResolvedValue({
        hasData: true,
        payload: { orders: [] },
        summary: '测试',
      });
      (mockStrategy.buildMessage as jest.Mock).mockReturnValue('test message');

      await service.executeTask(mockStrategy, { forceEnabled: true, forceSend: true });

      // forceSend=true → dryRun=false
      expect(notificationSenderService.sendToGroup).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.sendToGroup.mock.calls[0][3]).toBe(false);

      expect(notificationSenderService.reportToFeishu).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.reportToFeishu.mock.calls[0][1]).toBe(false);
    });

    it('should pass dryRun=true when config.dryRun=true and no force flags', async () => {
      const dryRunConfig = {
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: true,
        dryRun: true,
      };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(dryRunConfig);

      const mockGroup = {
        imRoomId: 'room-1',
        groupName: '测试群',
        city: '上海',
        tag: '抢单群',
        imBotId: 'bot-1',
        token: 'token-1',
        chatId: 'chat-1',
      };
      groupResolverService.resolveGroups.mockResolvedValue([mockGroup]);
      (mockStrategy.fetchData as jest.Mock).mockResolvedValue({
        hasData: true,
        payload: { orders: [] },
        summary: '测试',
      });
      (mockStrategy.buildMessage as jest.Mock).mockReturnValue('test message');

      await service.executeTask(mockStrategy);

      expect(notificationSenderService.sendToGroup).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.sendToGroup.mock.calls[0][3]).toBe(true);

      expect(notificationSenderService.reportToFeishu).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.reportToFeishu.mock.calls[0][1]).toBe(true);
    });

    it('should skip duplicate execution when task lock is already held', async () => {
      const enabledConfig = { ...DEFAULT_GROUP_TASK_CONFIG, enabled: true, dryRun: true };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(enabledConfig);
      redisClient.set.mockResolvedValue(null);

      await service.executeTask(mockStrategy);

      expect(groupResolverService.resolveGroups).not.toHaveBeenCalled();
      expect(notificationSenderService.sendToGroup).not.toHaveBeenCalled();
      expect(notificationSenderService.reportToFeishu).not.toHaveBeenCalled();
      expect(redisClient.eval).not.toHaveBeenCalled();
    });

    it('should release task lock after execution', async () => {
      const enabledConfig = { ...DEFAULT_GROUP_TASK_CONFIG, enabled: true, dryRun: true };
      systemConfigService.getGroupTaskConfig.mockResolvedValue(enabledConfig);

      const mockGroup = {
        imRoomId: 'room-1',
        groupName: '测试群',
        city: '上海',
        tag: '抢单群',
        imBotId: 'bot-1',
        token: 'token-1',
        chatId: 'chat-1',
      };
      groupResolverService.resolveGroups.mockResolvedValue([mockGroup]);
      (mockStrategy.fetchData as jest.Mock).mockResolvedValue({
        hasData: true,
        payload: { orders: [] },
        summary: '测试',
      });
      (mockStrategy.buildMessage as jest.Mock).mockReturnValue('test message');

      await service.executeTask(mockStrategy);

      expect(redisClient.set).toHaveBeenCalledWith(
        'group-task:lock:order_grab',
        expect.any(String),
        expect.objectContaining({ nx: true, ex: 300 }),
      );
      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        ['group-task:lock:order_grab'],
        [expect.any(String)],
      );
    });
  });
});
