import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { GroupTaskType, GroupContext, TaskExecutionResult } from '@biz/group-task/group-task.types';
import { OpsNotifierService } from '@notification/services/ops-notifier.service';

describe('NotificationSenderService', () => {
  let service: NotificationSenderService;
  let messageSenderService: jest.Mocked<MessageSenderService>;
  let opsNotifierService: jest.Mocked<OpsNotifierService>;

  const mockGroup: GroupContext = {
    imRoomId: 'room-123',
    groupName: '测试群',
    city: '上海',
    tag: '抢单群',
    imBotId: 'bot-1',
    token: 'token-1',
    chatId: 'chat-1',
  };

  const mockResult: TaskExecutionResult = {
    type: GroupTaskType.ORDER_GRAB,
    totalGroups: 5,
    successCount: 3,
    failedCount: 0,
    skippedCount: 2,
    errors: [],
    details: [],
    startTime: new Date(),
    endTime: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationSenderService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'STRIDE_ENTERPRISE_TOKEN') return 'test-enterprise-token';
              if (key === 'GROUP_TASK_SEND_DELAY_MS') return '0';
              if (key === 'MINIPROGRAM_APPID') return 'wx-test-appid';
              if (key === 'MINIPROGRAM_USERNAME') return 'gh_test_username';
              if (key === 'MINIPROGRAM_THUMB_URL') return 'https://example.com/thumb.png';
              return defaultValue ?? '';
            }),
          } as unknown as ConfigService,
        },
        {
          provide: MessageSenderService,
          useValue: {
            sendMessage: jest.fn().mockResolvedValue(undefined),
          } as unknown as MessageSenderService,
        },
        {
          provide: OpsNotifierService,
          useValue: {
            sendGroupTaskPreview: jest.fn().mockResolvedValue(true),
            sendGroupTaskReport: jest.fn().mockResolvedValue(undefined),
          } as unknown as OpsNotifierService,
        },
      ],
    }).compile();

    service = module.get<NotificationSenderService>(NotificationSenderService);
    messageSenderService = module.get(MessageSenderService) as jest.Mocked<MessageSenderService>;
    opsNotifierService = module.get(OpsNotifierService) as jest.Mocked<OpsNotifierService>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendToGroup', () => {
    it('should NOT call messageSenderService when dryRun is true', async () => {
      await service.sendToGroup(mockGroup, 'Hello group', GroupTaskType.ORDER_GRAB, true);

      expect(messageSenderService.sendMessage).not.toHaveBeenCalled();
    });

    it('should call feishu preview when dryRun is true', async () => {
      await service.sendToGroup(mockGroup, 'Hello group', GroupTaskType.ORDER_GRAB, true);

      expect(opsNotifierService.sendGroupTaskPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          groupName: '测试群',
          message: 'Hello group',
          dryRun: true,
        }),
      );
    });

    it('should fail fast when dryRun feishu preview cannot be sent', async () => {
      opsNotifierService.sendGroupTaskPreview.mockRejectedValueOnce(new Error('webhook rejected'));

      await expect(
        service.sendToGroup(mockGroup, 'Hello group', GroupTaskType.ORDER_GRAB, true),
      ).rejects.toThrow('webhook rejected');

      expect(messageSenderService.sendMessage).not.toHaveBeenCalled();
    });

    it('should call messageSenderService when dryRun is false', async () => {
      await service.sendToGroup(mockGroup, 'Hello group', GroupTaskType.ORDER_GRAB, false);

      expect(messageSenderService.sendMessage).toHaveBeenCalled();
    });

    it('should call both feishu preview and messageSenderService when dryRun is false', async () => {
      await service.sendToGroup(mockGroup, 'Hello group', GroupTaskType.ORDER_GRAB, false);

      expect(opsNotifierService.sendGroupTaskPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          groupName: '测试群',
          message: 'Hello group',
          dryRun: false,
        }),
      );
      expect(messageSenderService.sendMessage).toHaveBeenCalled();
    });

    it('should continue enterprise send when production feishu preview fails', async () => {
      opsNotifierService.sendGroupTaskPreview.mockResolvedValueOnce(false);

      await service.sendToGroup(mockGroup, 'Hello group', GroupTaskType.ORDER_GRAB, false);

      expect(opsNotifierService.sendGroupTaskPreview).toHaveBeenCalled();
      expect(messageSenderService.sendMessage).toHaveBeenCalled();
    });

    it('should send mini program card via enterprise API for part-time job notifications', async () => {
      await service.sendToGroup(mockGroup, '兼职岗位通知', GroupTaskType.PART_TIME_JOB, false);

      expect(messageSenderService.sendMessage).toHaveBeenCalledTimes(2);
      expect(messageSenderService.sendMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          token: 'test-enterprise-token',
          imBotId: 'bot-1',
          imRoomId: 'room-123',
          messageType: 9,
          payload: expect.objectContaining({
            appid: 'wx-test-appid',
            username: 'gh_test_username',
            title: '独立客找工作',
          }),
        }),
      );
    });

    it('should surface enterprise API errors for mini program card sending', async () => {
      messageSenderService.sendMessage
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('enterprise api failed'));

      await expect(
        service.sendToGroup(mockGroup, '兼职岗位通知', GroupTaskType.PART_TIME_JOB, false),
      ).rejects.toThrow('[兼职群] 小程序卡片发送失败 (测试群): enterprise api failed');
    });

    it('should apply a humanized delay before enterprise sends when delay is configured', async () => {
      const delayedService = new NotificationSenderService(
        {
          get: jest.fn((key: string, defaultValue?: string) => {
            if (key === 'STRIDE_ENTERPRISE_TOKEN') return 'test-enterprise-token';
            if (key === 'GROUP_TASK_SEND_DELAY_MS') return '2000';
            return defaultValue ?? '';
          }),
        } as unknown as ConfigService,
        messageSenderService,
        opsNotifierService,
      );
      const delaySpy = jest
        .spyOn(delayedService as never, 'delay')
        .mockResolvedValue(undefined as never);
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

      await delayedService.sendTextToGroup(mockGroup, 'Hello group', false);

      expect(delaySpy).toHaveBeenCalledWith(4500);
      expect(messageSenderService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'test-enterprise-token',
          imBotId: 'bot-1',
          imRoomId: 'room-123',
          messageType: 7,
          payload: { text: 'Hello group' },
        }),
      );

      randomSpy.mockRestore();
    });

    it('should default group task send delay to one minute when config is absent', () => {
      const defaultDelayService = new NotificationSenderService(
        {
          get: jest.fn((_: string, defaultValue?: string) => defaultValue ?? ''),
        } as unknown as ConfigService,
        messageSenderService,
        opsNotifierService,
      );

      expect((defaultDelayService as unknown as { sendDelayMs: number }).sendDelayMs).toBe(60000);
    });
  });

  describe('reportToFeishu', () => {
    it('should include [试运行] in title when dryRun is true', async () => {
      await service.reportToFeishu(mockResult, true);

      expect(opsNotifierService.sendGroupTaskReport).toHaveBeenCalledWith(
        expect.objectContaining({
          typeName: expect.stringContaining('试运行'),
        }),
      );
    });

    it('should NOT include [试运行] in title when dryRun is false', async () => {
      await service.reportToFeishu(mockResult, false);

      expect(opsNotifierService.sendGroupTaskReport).toHaveBeenCalledWith(
        expect.objectContaining({
          typeName: expect.not.stringContaining('试运行'),
        }),
      );
    });

    it('should include a partial failure section header when partial details exist', async () => {
      const partialResult: TaskExecutionResult = {
        ...mockResult,
        successCount: 2,
        failedCount: 1,
        skippedCount: 0,
        errors: [{ groupName: '群C', error: '小程序卡片发送失败: errcode=500' }],
        details: [
          {
            groupKey: '上海',
            groupCount: 2,
            dataSummary: '2条已发送',
            status: 'success',
            groupNames: ['群A', '群B'],
          },
          {
            groupKey: '成都',
            groupCount: 1,
            dataSummary: '1群成功，1群失败',
            status: 'partial',
            groupNames: ['群C'],
          },
          {
            groupKey: '武汉',
            groupCount: 1,
            dataSummary: '接口异常',
            status: 'failed',
            groupNames: ['群D'],
          },
        ],
      };

      await service.reportToFeishu(partialResult, false);

      expect(opsNotifierService.sendGroupTaskReport).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.arrayContaining([
            expect.objectContaining({
              status: 'partial',
            }),
          ]),
        }),
      );
    });

    it('should throw when final message notification cannot be sent', async () => {
      opsNotifierService.sendGroupTaskReport.mockRejectedValueOnce(new Error('summary failed'));

      await expect(service.reportToFeishu(mockResult, false)).rejects.toThrow('summary failed');
    });

    it('should include concrete error details when result.errors is not empty', async () => {
      const failedResult: TaskExecutionResult = {
        ...mockResult,
        successCount: 0,
        failedCount: 1,
        skippedCount: 0,
        errors: [{ groupName: '测试群', error: '小程序卡片发送失败 (测试群): errcode=500' }],
        details: [
          {
            groupKey: '上海',
            groupCount: 1,
            dataSummary: '发送失败',
            status: 'failed',
            groupNames: ['测试群'],
          },
        ],
      };

      await service.reportToFeishu(failedResult, false);

      expect(opsNotifierService.sendGroupTaskReport).toHaveBeenCalledWith(
        expect.objectContaining({
          errors: expect.arrayContaining([
            expect.objectContaining({
              groupName: '测试群',
              error: expect.stringContaining('小程序卡片发送失败'),
            }),
          ]),
        }),
      );
    });
  });
});
