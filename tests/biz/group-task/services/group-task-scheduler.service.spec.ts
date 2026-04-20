import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bull';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { GroupTaskSchedulerService } from '@biz/group-task/services/group-task-scheduler.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { OrderGrabStrategy } from '@biz/group-task/strategies/order-grab.strategy';
import { PartTimeJobStrategy } from '@biz/group-task/strategies/part-time-job.strategy';
import { StoreManagerStrategy } from '@biz/group-task/strategies/store-manager.strategy';
import { WorkTipsStrategy } from '@biz/group-task/strategies/work-tips.strategy';
import {
  GroupTaskType,
  DEFAULT_GROUP_TASK_CONFIG,
  TimeSlot,
} from '@biz/group-task/group-task.types';
import { NotificationStrategy } from '@biz/group-task/strategies/notification.strategy';
import {
  GROUP_TASK_QUEUE_NAME,
  GroupTaskJobName,
  PlanJobData,
} from '@biz/group-task/queue/group-task-queue.constants';
import { Environment } from '@enums/environment.enum';

/**
 * 群任务调度器（Bull 化后）：职责压缩到「配置闸门 + plan job 入队」。
 * 发送、飞书汇总等逻辑已迁移到 GroupTaskProcessor，对应测试由 processor.spec 负责。
 */
describe('GroupTaskSchedulerService', () => {
  let service: GroupTaskSchedulerService;
  let configService: jest.Mocked<ConfigService>;
  let systemConfigService: jest.Mocked<SystemConfigService>;
  let queueMock: { add: jest.Mock };
  let orderGrabStrategy: OrderGrabStrategy;
  let partTimeJobStrategy: PartTimeJobStrategy;
  let storeManagerStrategy: StoreManagerStrategy;
  let workTipsStrategy: WorkTipsStrategy;
  let currentNodeEnv: Environment;

  const mockStrategy: NotificationStrategy = {
    type: GroupTaskType.ORDER_GRAB,
    tagPrefix: '抢单群',
    needsAI: false,
    prepareTask: jest.fn().mockResolvedValue(undefined),
    fetchData: jest.fn().mockResolvedValue([]),
    buildMessage: jest.fn().mockResolvedValue('test message'),
  } as unknown as NotificationStrategy;

  beforeEach(async () => {
    currentNodeEnv = Environment.Test;

    queueMock = {
      add: jest.fn().mockImplementation(async (_name, data: PlanJobData) => ({
        id: 'plan-job-1',
        name: GroupTaskJobName.PLAN,
        data,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupTaskSchedulerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'GROUP_TASK_SEND_DELAY_MS') return '0';
              if (key === 'NODE_ENV') return currentNodeEnv;
              return defaultValue ?? '';
            }),
          } as unknown as ConfigService,
        },
        {
          provide: SystemConfigService,
          useValue: {
            getGroupTaskConfig: jest.fn(),
            updateGroupTaskConfig: jest.fn(),
          } as unknown as SystemConfigService,
        },
        {
          provide: getQueueToken(GROUP_TASK_QUEUE_NAME),
          useValue: queueMock,
        },
        { provide: OrderGrabStrategy, useValue: mockStrategy as unknown as OrderGrabStrategy },
        {
          provide: PartTimeJobStrategy,
          useValue: {
            type: GroupTaskType.PART_TIME_JOB,
            tagPrefix: '兼职群',
            needsAI: false,
          } as unknown as PartTimeJobStrategy,
        },
        {
          provide: StoreManagerStrategy,
          useValue: {
            type: GroupTaskType.STORE_MANAGER,
            tagPrefix: '店长群',
            needsAI: false,
          } as unknown as StoreManagerStrategy,
        },
        {
          provide: WorkTipsStrategy,
          useValue: {
            type: GroupTaskType.WORK_TIPS,
            tagPrefix: '工作群',
            needsAI: true,
          } as unknown as WorkTipsStrategy,
        },
      ],
    }).compile();

    service = module.get<GroupTaskSchedulerService>(GroupTaskSchedulerService);
    configService = module.get(ConfigService) as jest.Mocked<ConfigService>;
    systemConfigService = module.get(SystemConfigService) as jest.Mocked<SystemConfigService>;
    orderGrabStrategy = module.get(OrderGrabStrategy);
    partTimeJobStrategy = module.get(PartTimeJobStrategy);
    storeManagerStrategy = module.get(StoreManagerStrategy);
    workTipsStrategy = module.get(WorkTipsStrategy);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getConfig', () => {
    it('should delegate to systemConfigService.getGroupTaskConfig', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue(DEFAULT_GROUP_TASK_CONFIG);

      const config = await service.getConfig();

      expect(config).toEqual(DEFAULT_GROUP_TASK_CONFIG);
    });
  });

  describe('updateConfig', () => {
    it('should delegate to systemConfigService.updateGroupTaskConfig', async () => {
      const updated = { enabled: true, dryRun: true };
      (systemConfigService.updateGroupTaskConfig as jest.Mock).mockResolvedValue(updated);

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

  describe('executeTask — 入队闸门', () => {
    it('should skip enqueueing when disabled and not forced', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue({
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: false,
      });

      const result = await service.executeTask(mockStrategy);

      expect(result).toEqual({ execId: null, skipped: 'disabled' });
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('should enqueue plan job when forceEnabled=true even if disabled', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue({
        ...DEFAULT_GROUP_TASK_CONFIG,
        enabled: false,
        dryRun: false,
      });

      const result = await service.executeTask(mockStrategy, { forceEnabled: true });

      expect(result.execId).toBeTruthy();
      expect(queueMock.add).toHaveBeenCalledTimes(1);
      const [name, data, opts] = queueMock.add.mock.calls[0];
      expect(name).toBe(GroupTaskJobName.PLAN);
      expect(data).toMatchObject({
        execId: result.execId,
        type: GroupTaskType.ORDER_GRAB,
        trigger: 'manual',
      });
      // jobId 前缀按 trigger 区分，便于排障
      expect(opts.jobId).toContain('plan:manual:order_grab:');
    });

    it('should freeze dryRun=config.dryRun into plan job when no force flags', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue({
        enabled: true,
        dryRun: true,
      });

      await service.executeTask(mockStrategy);

      const [, data] = queueMock.add.mock.calls[0];
      expect(data.dryRun).toBe(true);
    });

    it('should flip dryRun to false when forceSend=true even if config.dryRun=true', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue({
        enabled: true,
        dryRun: true,
      });

      await service.executeTask(mockStrategy, { forceEnabled: true, forceSend: true });

      const [, data] = queueMock.add.mock.calls[0];
      expect(data.dryRun).toBe(false);
    });

    it('should carry timeSlot through to plan job data', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue({
        enabled: true,
        dryRun: false,
      });

      await service.executeTask(mockStrategy, { timeSlot: TimeSlot.MORNING, trigger: 'cron' });

      const [, data, opts] = queueMock.add.mock.calls[0];
      expect(data.timeSlot).toBe(TimeSlot.MORNING);
      expect(data.trigger).toBe('cron');
      // cron 的 jobId 带 minute 粒度，便于同分钟重复触发去重
      expect(opts.jobId).toContain('plan:cron:order_grab:');
      expect(opts.jobId).toContain(':morning');
    });

    it('should detect duplicate jobId and mark skipped=duplicate', async () => {
      systemConfigService.getGroupTaskConfig.mockResolvedValue({
        enabled: true,
        dryRun: true,
      });
      queueMock.add.mockResolvedValueOnce({
        id: 'existing-plan',
        name: GroupTaskJobName.PLAN,
        data: { execId: 'existing-exec-id', type: GroupTaskType.ORDER_GRAB } as PlanJobData,
      });

      const result = await service.executeTask(mockStrategy, { trigger: 'cron' });

      expect(result).toEqual({
        execId: 'existing-exec-id',
        skipped: 'duplicate',
      });
    });
  });

  describe('cron environment guard', () => {
    const cronMethodNames = [
      'cronOrderGrabMorning',
      'cronOrderGrabAfternoon',
      'cronPartTimeJob',
      'cronOrderGrabEvening',
      'cronStoreManager',
      'cronWorkTips',
    ] as const;
    const cronCases = [
      {
        methodName: 'cronOrderGrabMorning' as const,
        getExpectedArgs: () =>
          [orderGrabStrategy, { timeSlot: TimeSlot.MORNING, trigger: 'cron' }] as const,
      },
      {
        methodName: 'cronOrderGrabAfternoon' as const,
        getExpectedArgs: () =>
          [orderGrabStrategy, { timeSlot: TimeSlot.AFTERNOON, trigger: 'cron' }] as const,
      },
      {
        methodName: 'cronPartTimeJob' as const,
        getExpectedArgs: () => [partTimeJobStrategy, { trigger: 'cron' }] as const,
      },
      {
        methodName: 'cronOrderGrabEvening' as const,
        getExpectedArgs: () =>
          [orderGrabStrategy, { timeSlot: TimeSlot.EVENING, trigger: 'cron' }] as const,
      },
      {
        methodName: 'cronStoreManager' as const,
        getExpectedArgs: () => [storeManagerStrategy, { trigger: 'cron' }] as const,
      },
      {
        methodName: 'cronWorkTips' as const,
        getExpectedArgs: () => [workTipsStrategy, { trigger: 'cron' }] as const,
      },
    ] as const;

    it.each(cronMethodNames)('should skip %s outside production', async (methodName) => {
      currentNodeEnv = Environment.Test;
      const executeTaskSpy = jest
        .spyOn(service, 'executeTask')
        .mockResolvedValue({ execId: 'x' });

      await service[methodName]();

      expect(configService.get).toHaveBeenCalledWith('NODE_ENV', Environment.Development);
      expect(executeTaskSpy).not.toHaveBeenCalled();
    });

    it.each(cronCases)(
      'should run $methodName in production',
      async ({ methodName, getExpectedArgs }) => {
        currentNodeEnv = Environment.Production;
        const executeTaskSpy = jest
          .spyOn(service, 'executeTask')
          .mockResolvedValue({ execId: 'x' });

        await service[methodName]();

        expect(executeTaskSpy).toHaveBeenCalledWith(...getExpectedArgs());
      },
    );
  });

  describe('cron metadata', () => {
    it('should schedule part-time group task at 13:30 on weekdays', () => {
      const metadata = Reflect.getMetadata(
        SCHEDULE_CRON_OPTIONS,
        GroupTaskSchedulerService.prototype.cronPartTimeJob,
      );

      expect(metadata).toEqual({
        cronTime: '30 13 * * 1-5',
        timeZone: 'Asia/Shanghai',
      });
    });
  });
});
