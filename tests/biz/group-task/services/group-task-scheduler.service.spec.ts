import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GroupTaskSchedulerService } from '@biz/group-task/services/group-task-scheduler.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { CompletionService } from '@agent/completion.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { BrandRotationService } from '@biz/group-task/services/brand-rotation.service';
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

  const mockStrategy: NotificationStrategy = {
    type: GroupTaskType.ORDER_GRAB,
    tagPrefix: '抢单群',
    needsAI: false,
    fetchData: jest.fn().mockResolvedValue([]),
    buildMessage: jest.fn().mockResolvedValue('test message'),
  } as unknown as NotificationStrategy;

  beforeEach(async () => {
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
          } as unknown as SystemConfigService,
        },
        {
          provide: CompletionService,
          useValue: {
            generateSimple: jest.fn().mockResolvedValue('AI generated text'),
          } as unknown as CompletionService,
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
    it('should return defaults when DB has no value', async () => {
      systemConfigService.getConfigValue.mockResolvedValue(null);

      const config = await service.getConfig();

      expect(config).toEqual(DEFAULT_GROUP_TASK_CONFIG);
    });

    it('should return stored values when DB has them', async () => {
      const storedConfig = {
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: true,
        dryRun: false,
      };
      systemConfigService.getConfigValue.mockResolvedValue(storedConfig);

      const config = await service.getConfig();

      expect(config).toEqual(storedConfig);
      expect(config.enabled).toBe(true);
      expect(config.dryRun).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should merge partial config with current and persist', async () => {
      systemConfigService.getConfigValue.mockResolvedValue({ enabled: false, dryRun: true });
      systemConfigService.setConfigValue.mockResolvedValue(undefined);

      const result = await service.updateConfig({ enabled: true });

      expect(result).toEqual({ enabled: true, dryRun: true });
      expect(systemConfigService.setConfigValue).toHaveBeenCalledWith(
        'group_task_config',
        { enabled: true, dryRun: true },
        '群任务通知配置',
      );
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
      systemConfigService.getConfigValue.mockResolvedValue(disabledConfig);

      await service.executeTask(mockStrategy, false);

      expect(groupResolverService.resolveGroups).not.toHaveBeenCalled();
      expect(notificationSenderService.sendToGroup).not.toHaveBeenCalled();
    });

    it('should run when forced even if disabled', async () => {
      const disabledConfig = { ...DEFAULT_GROUP_TASK_CONFIG, enabled: false };
      systemConfigService.getConfigValue.mockResolvedValue(disabledConfig);
      groupResolverService.resolveGroups.mockResolvedValue([]);

      await service.executeTask(mockStrategy, true);

      expect(notificationSenderService.reportToFeishu).toHaveBeenCalled();
    });

    it('should pass dryRun=false when force=true (bypasses dryRun)', async () => {
      const dryRunConfig = {
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: true,
        dryRun: true,
      };
      systemConfigService.getConfigValue.mockResolvedValue(dryRunConfig);

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

      await service.executeTask(mockStrategy, true);

      // force=true 应强制 dryRun=false
      expect(notificationSenderService.sendToGroup).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.sendToGroup.mock.calls[0][3]).toBe(false);

      expect(notificationSenderService.reportToFeishu).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.reportToFeishu.mock.calls[0][1]).toBe(false);
    });

    it('should pass dryRun=true when not forced and config.dryRun=true', async () => {
      const dryRunConfig = {
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: true,
        dryRun: true,
      };
      systemConfigService.getConfigValue.mockResolvedValue(dryRunConfig);

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

      await service.executeTask(mockStrategy, false);

      // force=false, config.dryRun=true → 传递 dryRun=true
      expect(notificationSenderService.sendToGroup).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.sendToGroup.mock.calls[0][3]).toBe(true);

      expect(notificationSenderService.reportToFeishu).toHaveBeenCalledTimes(1);
      expect(notificationSenderService.reportToFeishu.mock.calls[0][1]).toBe(true);
    });
  });
});
