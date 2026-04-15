import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';
import { MessagePipelineService } from '@wecom/message/application/pipeline.service';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { MessageWorkerManagerService } from '@wecom/message/runtime/message-worker-manager.service';

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageProcessor,
        MessageWorkerManagerService,
        { provide: getQueueToken('message-merge'), useValue: mockQueue },
        { provide: MessagePipelineService, useValue: mockPipeline },
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
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
