import { getQueueToken } from '@nestjs/bull';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { GroupTaskAdminService } from '@biz/group-task/services/group-task-admin.service';
import { GroupTaskSchedulerService } from '@biz/group-task/services/group-task-scheduler.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { GroupTaskType } from '@biz/group-task/group-task.types';
import {
  GROUP_TASK_QUEUE_NAME,
  GroupTaskJobName,
} from '@biz/group-task/queue/group-task-queue.constants';

describe('GroupTaskAdminService', () => {
  let service: GroupTaskAdminService;
  const scheduler = { getStrategy: jest.fn(), executeTask: jest.fn() };
  const groupResolver = { findGroupByName: jest.fn() };
  const notificationSender = { sendToGroup: jest.fn(), sendTextToGroup: jest.fn() };
  const llm = { generateSimple: jest.fn() };
  const queue = {
    getFailed: jest.fn().mockResolvedValue([]),
    getWaiting: jest.fn().mockResolvedValue([]),
    getActive: jest.fn().mockResolvedValue([]),
    getDelayed: jest.fn().mockResolvedValue([]),
    getCompleted: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupTaskAdminService,
        { provide: GroupTaskSchedulerService, useValue: scheduler },
        { provide: GroupResolverService, useValue: groupResolver },
        { provide: NotificationSenderService, useValue: notificationSender },
        { provide: LlmExecutorService, useValue: llm },
        { provide: getQueueToken(GROUP_TASK_QUEUE_NAME), useValue: queue },
      ],
    }).compile();

    service = module.get(GroupTaskAdminService);
    jest.clearAllMocks();
    queue.getFailed.mockResolvedValue([]);
    queue.getWaiting.mockResolvedValue([]);
    queue.getActive.mockResolvedValue([]);
    queue.getDelayed.mockResolvedValue([]);
    queue.getCompleted.mockResolvedValue([]);
  });

  it('triggers a known strategy with manual force-enabled options', async () => {
    const strategy = { type: GroupTaskType.ORDER_GRAB };
    scheduler.getStrategy.mockReturnValue(strategy);
    scheduler.executeTask.mockResolvedValue({ execId: 'exec-123' });

    await expect(service.trigger(GroupTaskType.ORDER_GRAB)).resolves.toMatchObject({
      success: true,
      execId: 'exec-123',
      type: GroupTaskType.ORDER_GRAB,
    });

    expect(scheduler.executeTask).toHaveBeenCalledWith(strategy, {
      forceEnabled: true,
      trigger: 'manual',
    });
  });

  it('rejects unknown task type', async () => {
    scheduler.getStrategy.mockReturnValue(null);

    await expect(service.trigger('invalid-type' as GroupTaskType)).rejects.toThrow(HttpException);

    try {
      await service.trigger('invalid-type' as GroupTaskType);
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });

  it('retries failed send jobs for the requested type', async () => {
    const retryA = jest.fn().mockResolvedValue(undefined);
    const retryB = jest.fn().mockResolvedValue(undefined);
    queue.getFailed.mockResolvedValue([
      {
        id: 'send-A',
        name: GroupTaskJobName.SEND,
        data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群A' } },
        retry: retryA,
      },
      {
        id: 'send-B',
        name: GroupTaskJobName.SEND,
        data: { type: GroupTaskType.ORDER_GRAB, group: { groupName: '群B' } },
        retry: jest.fn(),
      },
      {
        id: 'send-C',
        name: GroupTaskJobName.SEND,
        data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群C' } },
        retry: retryB,
      },
    ]);

    const result = await service.retry(GroupTaskType.PART_TIME_JOB);

    expect(retryA).toHaveBeenCalledTimes(1);
    expect(retryB).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, retriedCount: 2 });
  });

  it('aggregates queue status', async () => {
    queue.getWaiting.mockResolvedValue([
      { id: 'w-1', name: GroupTaskJobName.PREPARE, data: { type: GroupTaskType.PART_TIME_JOB } },
    ]);
    queue.getFailed.mockResolvedValue([
      {
        id: 'f-1',
        name: GroupTaskJobName.SEND,
        data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群F' } },
        failedReason: '企微限流',
        attemptsMade: 3,
      },
    ]);

    const result = await service.status(GroupTaskType.PART_TIME_JOB);

    expect(result.counts.waiting).toBe(1);
    expect(result.counts.failed).toBe(1);
    expect(result.failedSendGroups).toEqual([
      { jobId: 'f-1', groupName: '群F', failedReason: '企微限流', attemptsMade: 3 },
    ]);
  });

  it('runs test-send with AI-generated message and follow-up', async () => {
    const strategy = {
      needsAI: true,
      fetchData: jest.fn().mockResolvedValue({
        hasData: true,
        summary: '有数据',
        payload: { followUpMessage: '补充一句' },
      }),
      buildPrompt: jest.fn().mockReturnValue({ systemPrompt: 'sys', userMessage: 'user' }),
      appendFooter: jest.fn((message: string) => `${message}\nfooter`),
    };
    scheduler.getStrategy.mockReturnValue(strategy);
    groupResolver.findGroupByName.mockResolvedValue({ groupName: '测试群', roomId: 'room-1' });
    llm.generateSimple.mockResolvedValue('AI 文案');

    const result = await service.testSend({
      type: GroupTaskType.ORDER_GRAB,
      groupName: '测试群',
      forceSend: true,
    });

    expect(notificationSender.sendToGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: '测试群' }),
      'AI 文案\nfooter',
      GroupTaskType.ORDER_GRAB,
      false,
    );
    expect(notificationSender.sendTextToGroup).toHaveBeenCalledWith(
      expect.objectContaining({ groupName: '测试群' }),
      '补充一句',
      false,
    );
    expect(result).toMatchObject({ success: true, dryRun: false, message: 'AI 文案\nfooter' });
  });
});
