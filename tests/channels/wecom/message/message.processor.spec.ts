import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';
import { MessagePipelineService } from '@wecom/message/application/pipeline.service';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { MessageDeduplicationService } from '@wecom/message/runtime/deduplication.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { MessageWorkerManagerService } from '@wecom/message/runtime/message-worker-manager.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';

describe('MessageProcessor', () => {
  let processor: MessageProcessor;

  const mockQueue = {
    on: jest.fn(),
    process: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
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
    startLockHeartbeat: jest.fn().mockReturnValue(jest.fn()),
    isQuietWindowElapsed: jest.fn().mockResolvedValue(true),
    claimPendingSnapshot: jest.fn(),
    ackPendingMessages: jest.fn().mockResolvedValue(undefined),
    checkAndProcessNewMessages: jest.fn().mockResolvedValue(false),
    scheduleLockRetryCheck: jest.fn().mockResolvedValue(undefined),
    scheduleQuietWindowRetryCheck: jest.fn().mockResolvedValue(true),
  };

  const mockConfigService = {
    // 排空超时压到 100ms，避免 close 挂起的用例拖慢测试
    get: jest.fn((key: string, defaultValue?: string) =>
      key === 'SHUTDOWN_DRAIN_TIMEOUT_MS' ? '100' : defaultValue,
    ),
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

  const mockMessageTracking = {
    dropMergedSourceRecords: jest.fn().mockResolvedValue(undefined),
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
        { provide: MessageTrackingService, useValue: mockMessageTracking },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    processor = module.get<MessageProcessor>(MessageProcessor);
    jest.clearAllMocks();
  });

  it('should delegate merged batches to MessagePipelineService with initial snapshot size', async () => {
    const messages = [
      {
        chatId: 'chat-123',
        messageId: 'msg-123',
      },
    ];

    await (processor as any).processMessages(messages, 'batch-001', 1);

    expect(mockPipeline.processMergedMessages).toHaveBeenCalledWith(messages, 'batch-001', 1);
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

      const dropped = await (processor as any).dropIfHostingPaused('chat-123', messages, 'job-9');

      expect(dropped).toBe(true);
      // 议题 8-4：本批不会再进 Agent，intake 时写下的 processing 流水必须当场回收，
      // 否则会一直停在 processing 直到 03:00 UTC cron 标 timeout，污染观测口径。
      expect(mockMessageTracking.dropMergedSourceRecords).toHaveBeenCalledWith(
        messages.map((message: { messageId: string }) => message.messageId),
        'job-9',
      );
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
      expect(mockMessageTracking.dropMergedSourceRecords).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy (优雅排空)', () => {
    it('closes the queue and waits for in-flight jobs to finish', async () => {
      mockQueue.close.mockResolvedValueOnce(undefined);

      await processor.onModuleDestroy();

      expect(mockQueue.close).toHaveBeenCalled();
    });

    it('gives up waiting after drain timeout when close hangs', async () => {
      mockQueue.close.mockReturnValueOnce(new Promise(() => undefined));

      await expect(processor.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('swallows close errors instead of blocking shutdown', async () => {
      mockQueue.close.mockRejectedValueOnce(new Error('redis gone'));

      await expect(processor.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('handleProcessJob 锁冲突', () => {
    it('schedules a lock-retry check instead of silently dropping (2026-06-09 发版事故)', async () => {
      mockSimpleMergeService.acquireProcessingLock.mockResolvedValueOnce(false);

      await (processor as any).handleProcessJob({ id: 'job-1', data: { chatId: 'chat-123' } });

      expect(mockSimpleMergeService.scheduleLockRetryCheck).toHaveBeenCalledWith('chat-123');
      expect(mockSimpleMergeService.claimPendingSnapshot).not.toHaveBeenCalled();
      // 没拿到锁就不该去释放别人的锁
      expect(mockSimpleMergeService.releaseProcessingLock).not.toHaveBeenCalled();
    });

    it('重检任务创建失败时让当前 Bull job 失败而不是静默完成', async () => {
      mockSimpleMergeService.acquireProcessingLock.mockResolvedValueOnce(false);
      mockSimpleMergeService.scheduleLockRetryCheck.mockRejectedValueOnce(
        new Error('queue unavailable'),
      );

      await expect(
        (processor as any).handleProcessJob({ id: 'job-lock-fail', data: { chatId: 'chat-123' } }),
      ).rejects.toThrow('queue unavailable');
    });
  });

  describe('handleProcessJob 静默窗口提前唤醒', () => {
    it('补建剩余窗口检查，避免当前 job return 后 pending 永久无人接手', async () => {
      mockSimpleMergeService.isQuietWindowElapsed.mockResolvedValueOnce(false);

      await (processor as any).handleProcessJob({
        id: 'job-quiet-early',
        data: { chatId: 'chat-quiet' },
      });

      expect(mockSimpleMergeService.scheduleQuietWindowRetryCheck).toHaveBeenCalledWith(
        'chat-quiet',
      );
      expect(mockSimpleMergeService.claimPendingSnapshot).not.toHaveBeenCalled();
    });

    it('补建失败时上抛，由 Bull failed/retry 暴露并重试', async () => {
      mockSimpleMergeService.isQuietWindowElapsed.mockResolvedValueOnce(false);
      mockSimpleMergeService.scheduleQuietWindowRetryCheck.mockRejectedValueOnce(
        new Error('quiet retry failed'),
      );

      await expect(
        (processor as any).handleProcessJob({
          id: 'job-quiet-fail',
          data: { chatId: 'chat-quiet' },
        }),
      ).rejects.toThrow('quiet retry failed');
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
