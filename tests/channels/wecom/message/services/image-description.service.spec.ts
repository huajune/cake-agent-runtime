import { Test, TestingModule } from '@nestjs/testing';
import { ImageDescriptionService } from '@wecom/message/application/image-description.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ModelRole } from '@/llm/llm.types';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImageDescriptionService,
        { provide: LlmExecutorService, useValue: mockLlm },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: AlertNotifierService, useValue: mockAlertService },
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
      mockChatSessionService.updateMessageContent.mockResolvedValue(undefined);

      service.describeAndUpdateAsync('msg-123', 'https://example.com/image.jpg');

      // Wait for the fire-and-forget promise to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockLlm.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          role: ModelRole.Vision,
          system: expect.any(String),
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
  });
});
