import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { MessageSenderService } from '@channels/wecom/message-sender/message-sender.service';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import {
  GroupTaskType,
  GroupContext,
  TaskExecutionResult,
} from '@biz/group-task/group-task.types';

describe('NotificationSenderService', () => {
  let service: NotificationSenderService;
  let messageSenderService: jest.Mocked<MessageSenderService>;
  let webhookService: jest.Mocked<FeishuWebhookService>;
  let cardBuilder: jest.Mocked<FeishuCardBuilderService>;

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
          provide: FeishuWebhookService,
          useValue: {
            sendMessage: jest.fn().mockResolvedValue(true),
          } as unknown as FeishuWebhookService,
        },
        {
          provide: FeishuCardBuilderService,
          useValue: {
            buildMarkdownCard: jest.fn().mockReturnValue({ msg_type: 'interactive' }),
          } as unknown as FeishuCardBuilderService,
        },
      ],
    }).compile();

    service = module.get<NotificationSenderService>(
      NotificationSenderService,
    );
    messageSenderService = module.get(
      MessageSenderService,
    ) as jest.Mocked<MessageSenderService>;
    webhookService = module.get(FeishuWebhookService) as jest.Mocked<FeishuWebhookService>;
    cardBuilder = module.get(FeishuCardBuilderService) as jest.Mocked<FeishuCardBuilderService>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendToGroup', () => {
    it('should NOT call messageSenderService when dryRun is true', async () => {
      await service.sendToGroup(
        mockGroup,
        'Hello group',
        GroupTaskType.ORDER_GRAB,
        true,
      );

      expect(messageSenderService.sendMessage).not.toHaveBeenCalled();
    });

    it('should call feishu preview when dryRun is true', async () => {
      await service.sendToGroup(
        mockGroup,
        'Hello group',
        GroupTaskType.ORDER_GRAB,
        true,
      );

      expect(webhookService.sendMessage).toHaveBeenCalledWith(
        'MESSAGE_NOTIFICATION',
        expect.any(Object),
      );
    });

    it('should call messageSenderService when dryRun is false', async () => {
      await service.sendToGroup(
        mockGroup,
        'Hello group',
        GroupTaskType.ORDER_GRAB,
        false,
      );

      expect(messageSenderService.sendMessage).toHaveBeenCalled();
    });

    it('should call both feishu preview and messageSenderService when dryRun is false', async () => {
      await service.sendToGroup(
        mockGroup,
        'Hello group',
        GroupTaskType.ORDER_GRAB,
        false,
      );

      expect(webhookService.sendMessage).toHaveBeenCalledWith(
        'MESSAGE_NOTIFICATION',
        expect.any(Object),
      );
      expect(messageSenderService.sendMessage).toHaveBeenCalled();
    });
  });

  describe('reportToFeishu', () => {
    it('should include [试运行] in title when dryRun is true', async () => {
      await service.reportToFeishu(mockResult, true);

      expect(cardBuilder.buildMarkdownCard).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('试运行'),
        }),
      );
    });

    it('should NOT include [试运行] in title when dryRun is false', async () => {
      await service.reportToFeishu(mockResult, false);

      expect(cardBuilder.buildMarkdownCard).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.not.stringContaining('试运行'),
        }),
      );
    });
  });
});
