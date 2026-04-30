import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';
import { MessagePipelineService } from '@wecom/message/application/pipeline.service';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { MessageDeduplicationService } from '@wecom/message/runtime/deduplication.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { MessageWorkerManagerService } from '@wecom/message/runtime/message-worker-manager.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

describe('MessageProcessor', () => {
  let processor: MessageProcessor;

  const mockQueue = {
    on: jest.fn(),
    process: jest.fn(),
    getWaitingCount: jest.fn().mockResolvedValue(0),
    getActiveCount: jest.fn().mockResolvedValue(0),
    getCompletedCount: jest.fn().mockResolvedValue(0),
    getFailedCount: jest.fn().mockResolvedValue(0),
    getDelayedCount: jest.fn().mockResolvedValue(0),
    getPausedCount: jest.fn().mockResolvedValue(0),
  };

  const mockPipeline = {
    processMergedMessages: jest.fn().mockResolvedValue(undefined),
  };

  const mockSimpleMergeService = {
    acquireProcessingLock: jest.fn().mockResolvedValue(true),
    releaseProcessingLock: jest.fn().mockResolvedValue(undefined),
    isQuietWindowElapsed: jest.fn().mockResolvedValue(true),
    getAndClearPendingMessages: jest.fn(),
    checkAndProcessNewMessages: jest.fn().mockResolvedValue(false),
  };

  const mockSystemConfigService = {
    getSystemConfig: jest.fn().mockResolvedValue(undefined),
    updateSystemConfig: jest.fn().mockResolvedValue(undefined),
    getMessageMergeEnabled: jest.fn().mockResolvedValue(true),
  };

  const mockUserHostingService = {
    isAnyPaused: jest.fn().mockResolvedValue({ paused: false }),
  };

  const mockDeduplicationService = {
    markMessageAsProcessedAsync: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageProcessor,
        MessageWorkerManagerService,
        { provide: getQueueToken('message-merge'), useValue: mockQueue },
        { provide: MessagePipelineService, useValue: mockPipeline },
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        { provide: UserHostingService, useValue: mockUserHostingService },
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
      ],
    }).compile();

    processor = module.get<MessageProcessor>(MessageProcessor);
    jest.clearAllMocks();
  });

  it('should delegate merged batches to MessagePipelineService', async () => {
    const messages = [
      {
        chatId: 'chat-123',
        messageId: 'msg-123',
      },
    ];

    await (processor as any).processMessages(messages, 'batch-001');

    expect(mockPipeline.processMergedMessages).toHaveBeenCalledWith(messages, 'batch-001');
  });

  describe('dropIfHostingPaused', () => {
    it('drops batch and dedup-marks every messageId when paused (badcase 1tsdimfg)', async () => {
      mockUserHostingService.isAnyPaused.mockResolvedValueOnce({
        paused: true,
        matchedId: 'chat-123',
      });
      const messages = [
        { chatId: 'chat-123', messageId: 'msg-1', imContactId: 'c-1' },
        { chatId: 'chat-123', messageId: 'msg-2', imContactId: 'c-1' },
      ];

      const dropped = await (processor as any).dropIfHostingPaused(
        'chat-123',
        messages,
        'job-9',
      );

      expect(dropped).toBe(true);
      expect(mockUserHostingService.isAnyPaused).toHaveBeenCalledWith([
        'chat-123',
        'c-1',
        undefined,
      ]);
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledTimes(2);
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-2');
    });

    it('returns false and does not touch dedup when not paused', async () => {
      mockUserHostingService.isAnyPaused.mockResolvedValueOnce({ paused: false });
      const messages = [{ chatId: 'chat-1', messageId: 'msg-1', imContactId: 'c-1' }];

      const dropped = await (processor as any).dropIfHostingPaused('chat-1', messages, 'job-1');

      expect(dropped).toBe(false);
      expect(mockDeduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalled();
    });
  });

  it('should expose worker status with merge flag', async () => {
    const result = await processor.getWorkerStatus();

    expect(mockSystemConfigService.getMessageMergeEnabled).toHaveBeenCalled();
    expect(result).toEqual({
      concurrency: 4,
      activeJobs: 0,
      minConcurrency: 1,
      maxConcurrency: 20,
      messageMergeEnabled: true,
    });
  });
});
