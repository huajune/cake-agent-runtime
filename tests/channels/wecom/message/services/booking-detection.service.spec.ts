import { Test, TestingModule } from '@nestjs/testing';
import { BookingDetectionService } from '@wecom/message/services/booking-detection.service';
import { FeishuBookingService } from '@core/feishu';
import { BookingRepository } from '@biz/message/repositories/booking.repository';
import { ChatResponse } from '@agent';

describe('BookingDetectionService', () => {
  let service: BookingDetectionService;

  const mockFeishuBookingService = {
    sendBookingNotification: jest.fn(),
  };

  const mockBookingRepository = {
    incrementBookingCount: jest.fn(),
  };

  const successChatResponse: ChatResponse = {
    messages: [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-invocation',
            toolName: 'duliday_book_interview',
            input: {
              candidateName: 'Alice',
              brandName: 'TestBrand',
              storeName: 'Downtown Store',
              interviewTime: '2024-01-15 14:00',
              contactInfo: '13800138000',
            },
            output: {
              text: JSON.stringify({
                booking_id: 'BK001',
                message: '预约成功',
              }),
            },
          } as any,
          { type: 'text', text: '预约已为您安排好' },
        ],
      },
    ],
  } as any;

  const failureChatResponse: ChatResponse = {
    messages: [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool-invocation',
            toolName: 'duliday_book_interview',
            input: { candidateName: 'Bob' },
            output: { text: '预约失败，时间段已满' },
          } as any,
        ],
      },
    ],
  } as any;

  const noBookingChatResponse: ChatResponse = {
    messages: [
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Just a regular response' }],
      },
    ],
  } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingDetectionService,
        { provide: FeishuBookingService, useValue: mockFeishuBookingService },
        { provide: BookingRepository, useValue: mockBookingRepository },
      ],
    }).compile();

    service = module.get<BookingDetectionService>(BookingDetectionService);
    jest.clearAllMocks();

    mockFeishuBookingService.sendBookingNotification.mockResolvedValue(undefined);
    mockBookingRepository.incrementBookingCount.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('detectBookingSuccess', () => {
    it('should detect successful booking in agent response', () => {
      const result = service.detectBookingSuccess(successChatResponse);

      expect(result.detected).toBe(true);
      expect(result.bookingInfo).toBeDefined();
    });

    it('should extract booking info from tool input', () => {
      const result = service.detectBookingSuccess(successChatResponse);

      expect(result.bookingInfo).toMatchObject({
        candidateName: 'Alice',
        brandName: 'TestBrand',
        storeName: 'Downtown Store',
        interviewTime: '2024-01-15 14:00',
        contactInfo: '13800138000',
      });
    });

    it('should return detected=false for failure tool output', () => {
      const result = service.detectBookingSuccess(failureChatResponse);

      expect(result.detected).toBe(false);
    });

    it('should return detected=false when no booking tool called', () => {
      const result = service.detectBookingSuccess(noBookingChatResponse);

      expect(result.detected).toBe(false);
    });

    it('should return detected=false when chatResponse is undefined', () => {
      const result = service.detectBookingSuccess(undefined);

      expect(result.detected).toBe(false);
    });

    it('should return detected=false when chatResponse has no messages', () => {
      const emptyResponse = { messages: [] } as any;

      const result = service.detectBookingSuccess(emptyResponse);

      expect(result.detected).toBe(false);
    });

    it('should ignore user role messages', () => {
      const userRoleResponse: ChatResponse = {
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'tool-invocation',
                toolName: 'duliday_book_interview',
                output: { text: '预约成功' },
              } as any,
            ],
          },
        ],
      } as any;

      const result = service.detectBookingSuccess(userRoleResponse);

      expect(result.detected).toBe(false);
    });

    it('should detect booking from booking_id keyword in output', () => {
      const responseWithBookingId: ChatResponse = {
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool-invocation',
                toolName: 'duliday_book_interview',
                input: {},
                output: { text: '{"booking_id":"BK-123","status":"created"}' },
              } as any,
            ],
          },
        ],
      } as any;

      const result = service.detectBookingSuccess(responseWithBookingId);

      expect(result.detected).toBe(true);
    });

    it('should not detect booking from unrelated tool calls', () => {
      const otherToolResponse: ChatResponse = {
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool-invocation',
                toolName: 'other_tool',
                output: { text: '预约成功' },
              } as any,
            ],
          },
        ],
      } as any;

      const result = service.detectBookingSuccess(otherToolResponse);

      expect(result.detected).toBe(false);
    });

    it('should return toolOutput with parsed tool response', () => {
      const result = service.detectBookingSuccess(successChatResponse);

      expect(result.toolOutput).toBeDefined();
      expect(result.toolOutput!['booking_id']).toBe('BK001');
    });
  });

  describe('handleBookingSuccessAsync', () => {
    const handleParams = {
      chatId: 'chat-123',
      contactName: 'Alice',
      userId: 'user-123',
      managerId: 'manager-123',
      managerName: 'Bob',
      chatResponse: successChatResponse,
    };

    it('should do nothing when no booking detected', async () => {
      await service.handleBookingSuccessAsync({
        ...handleParams,
        chatResponse: noBookingChatResponse,
      });

      // No async side effects triggered
      expect(mockFeishuBookingService.sendBookingNotification).not.toHaveBeenCalled();
      expect(mockBookingRepository.incrementBookingCount).not.toHaveBeenCalled();
    });

    it('should do nothing when chatResponse is undefined', async () => {
      await service.handleBookingSuccessAsync({ ...handleParams, chatResponse: undefined });

      expect(mockFeishuBookingService.sendBookingNotification).not.toHaveBeenCalled();
    });

    it('should trigger async notification and stats update on detected booking', async () => {
      await service.handleBookingSuccessAsync(handleParams);

      // Wait for setImmediate callbacks
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-123',
          userId: 'user-123',
          managerId: 'manager-123',
          managerName: 'Bob',
        }),
      );
      expect(mockBookingRepository.incrementBookingCount).toHaveBeenCalled();
    });

    it('should use contactName as candidateName fallback when no candidateName in bookingInfo', async () => {
      const responseWithoutCandidateName: ChatResponse = {
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool-invocation',
                toolName: 'duliday_book_interview',
                input: { brandName: 'TestBrand' }, // no candidateName
                output: { text: '预约成功' },
              } as any,
            ],
          },
        ],
      } as any;

      await service.handleBookingSuccessAsync({
        ...handleParams,
        chatResponse: responseWithoutCandidateName,
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateName: 'Alice', // falls back to contactName
        }),
      );
    });

    it('should handle feishu notification failure gracefully', async () => {
      mockFeishuBookingService.sendBookingNotification.mockRejectedValue(
        new Error('Feishu API error'),
      );

      await service.handleBookingSuccessAsync(handleParams);

      await new Promise((resolve) => setImmediate(resolve));

      // Should not throw - error is caught internally
      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalled();
    });

    it('should handle booking stats update failure gracefully', async () => {
      mockBookingRepository.incrementBookingCount.mockRejectedValue(new Error('DB error'));

      await service.handleBookingSuccessAsync(handleParams);

      await new Promise((resolve) => setImmediate(resolve));

      // Should not throw - error is caught internally
      expect(mockBookingRepository.incrementBookingCount).toHaveBeenCalled();
    });
  });
});
