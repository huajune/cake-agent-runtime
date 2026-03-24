import { Test, TestingModule } from '@nestjs/testing';
import { ImageDescriptionService } from '@wecom/message/services/image-description.service';
import { CompletionService } from '@agent/completion.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { ModelRole } from '@providers/types';

describe('ImageDescriptionService', () => {
  let service: ImageDescriptionService;

  const mockCompletionService = {
    generate: jest.fn(),
  };

  const mockChatSessionService = {
    updateMessageContent: jest.fn(),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImageDescriptionService,
        { provide: CompletionService, useValue: mockCompletionService },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
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
      mockCompletionService.generate.mockResolvedValue({
        text: description,
        usage: { totalTokens: 100 },
      });
      mockChatSessionService.updateMessageContent.mockResolvedValue(undefined);

      service.describeAndUpdateAsync('msg-123', 'https://example.com/image.jpg');

      // Wait for the fire-and-forget promise to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockCompletionService.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          role: ModelRole.Vision,
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
      mockCompletionService.generate.mockResolvedValue({
        text: '   ',
        usage: { totalTokens: 10 },
      });

      service.describeAndUpdateAsync('msg-456', 'https://example.com/image.jpg');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockCompletionService.generate).toHaveBeenCalled();
      expect(mockChatSessionService.updateMessageContent).not.toHaveBeenCalled();
    });

    it('should handle invalid URL gracefully', async () => {
      service.describeAndUpdateAsync('msg-789', 'not-a-valid-url');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockCompletionService.generate).not.toHaveBeenCalled();
      expect(mockChatSessionService.updateMessageContent).not.toHaveBeenCalled();
    });

    it('should catch and log errors without throwing', async () => {
      mockCompletionService.generate.mockRejectedValue(new Error('Vision API failed'));

      // Should not throw
      service.describeAndUpdateAsync('msg-error', 'https://example.com/image.jpg');

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockCompletionService.generate).toHaveBeenCalled();
      expect(mockChatSessionService.updateMessageContent).not.toHaveBeenCalled();
    });
  });
});
