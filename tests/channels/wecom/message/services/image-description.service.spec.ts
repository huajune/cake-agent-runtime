import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ImageDescriptionService } from '@wecom/message/application/image-description.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ModelRole } from '@/llm/llm.types';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { MessageType } from '@enums/message-callback.enum';

describe('ImageDescriptionService', () => {
  let service: ImageDescriptionService;

  const mockLlm = {
    generate: jest.fn(),
  };

  const mockChatSessionService = {
    updateMessageContent: jest.fn(),
  };

  const mockAlertService = {
    sendSimpleAlert: jest.fn().mockResolvedValue(true),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'STRIDE_ENTERPRISE_API_BASE_URL') return 'https://stride-bg.dpclouds.com/hub-api';
      if (key === 'STRIDE_ENTERPRISE_TOKEN') return 'test-token';
      return undefined;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImageDescriptionService,
        { provide: LlmExecutorService, useValue: mockLlm },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: AlertNotifierService, useValue: mockAlertService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ImageDescriptionService>(ImageDescriptionService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('describeAndUpdateAsync', () => {
    it('should call vision model and update message content on success', async () => {
      const description = '这是一个招聘平台的截图，显示了一个餐厅服务员岗位';
      mockLlm.generate.mockResolvedValue({
        text: description,
        usage: { totalTokens: 100 },
      });
      mockChatSessionService.updateMessageContent.mockResolvedValue(true);

      service.describeAndUpdateAsync('msg-123', 'https://example.com/image.jpg');

      // Wait for the fire-and-forget promise to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLlm.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          role: ModelRole.Vision,
          system: expect.stringContaining('品牌ID：10239'),
          maxOutputTokens: 256,
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([
                expect.objectContaining({ type: 'image' }),
                expect.objectContaining({ type: 'text' }),
              ]),
            }),
          ]),
        }),
      );
      expect(mockChatSessionService.updateMessageContent).toHaveBeenCalledWith(
        'msg-123',
        `[图片消息] ${description}`,
      );
    });

    it('should not update content when description is empty', async () => {
      mockLlm.generate.mockResolvedValue({
        text: '   ',
        usage: { totalTokens: 10 },
      });

      service.describeAndUpdateAsync('msg-456', 'https://example.com/image.jpg');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLlm.generate).toHaveBeenCalled();
      expect(mockChatSessionService.updateMessageContent).not.toHaveBeenCalled();
    });

    it('should handle invalid URL gracefully', async () => {
      service.describeAndUpdateAsync('msg-789', 'not-a-valid-url');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLlm.generate).not.toHaveBeenCalled();
      expect(mockChatSessionService.updateMessageContent).not.toHaveBeenCalled();
    });

    it('should catch and log errors without throwing', async () => {
      mockLlm.generate.mockRejectedValue(new Error('Vision API failed'));

      // Should not throw
      service.describeAndUpdateAsync('msg-error', 'https://example.com/image.jpg');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLlm.generate).toHaveBeenCalled();
      expect(mockChatSessionService.updateMessageContent).not.toHaveBeenCalled();
    });

    it('回写命中「无匹配行」时退避重试，行落库后成功写入（不静默丢描述）', async () => {
      const description = '招聘平台截图，餐厅服务员岗位';
      mockLlm.generate.mockResolvedValue({
        text: description,
        usage: { totalTokens: 100 },
      });
      // 首次：历史 insert 尚未落库（无匹配行 → false）；重试一次后命中 → true
      mockChatSessionService.updateMessageContent
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      service.describeAndUpdateAsync('msg-retry', 'https://example.com/image.jpg');

      // 退避基准 500ms，等待足够覆盖一次重试
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(mockChatSessionService.updateMessageContent).toHaveBeenCalledTimes(2);
      expect(mockChatSessionService.updateMessageContent).toHaveBeenLastCalledWith(
        'msg-retry',
        `[图片消息] ${description}`,
      );
    });

    it('should use [表情消息] prefix when kind is EMOTION', async () => {
      const description = '微笑表情';
      mockLlm.generate.mockResolvedValue({
        text: description,
        usage: { totalTokens: 50 },
      });
      mockChatSessionService.updateMessageContent.mockResolvedValue(true);

      service.describeAndUpdateAsync(
        'msg-emoji-1',
        'https://example.com/emoji.gif',
        MessageType.EMOTION,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLlm.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: 64,
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: 'text',
                  text: expect.stringContaining('4-12 个字'),
                }),
              ]),
            }),
          ]),
        }),
      );
      expect(mockChatSessionService.updateMessageContent).toHaveBeenCalledWith(
        'msg-emoji-1',
        `[表情消息] ${description}`,
      );
    });
  });
});
