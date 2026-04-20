import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bull';
import { GroupTaskController } from '@biz/group-task/group-task.controller';
import { GroupTaskSchedulerService } from '@biz/group-task/services/group-task-scheduler.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { CompletionService } from '@agent/completion.service';
import { GroupTaskType } from '@biz/group-task/group-task.types';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import {
  GROUP_TASK_QUEUE_NAME,
  GroupTaskJobName,
} from '@biz/group-task/queue/group-task-queue.constants';

describe('GroupTaskController', () => {
  let controller: GroupTaskController;
  let mockSchedulerService: Partial<GroupTaskSchedulerService>;
  const mockGroupResolverService = { findGroupByName: jest.fn() };
  const mockNotificationSenderService = { sendToGroup: jest.fn(), sendTextToGroup: jest.fn() };
  const mockCompletionService = { generateSimple: jest.fn() };
  let queueMock: {
    getFailed: jest.Mock;
    getWaiting: jest.Mock;
    getActive: jest.Mock;
    getDelayed: jest.Mock;
    getCompleted: jest.Mock;
  };

  beforeEach(async () => {
    mockSchedulerService = {
      getStrategy: jest.fn(),
      executeTask: jest.fn(),
    };

    queueMock = {
      getFailed: jest.fn().mockResolvedValue([]),
      getWaiting: jest.fn().mockResolvedValue([]),
      getActive: jest.fn().mockResolvedValue([]),
      getDelayed: jest.fn().mockResolvedValue([]),
      getCompleted: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupTaskController],
      providers: [
        {
          provide: GroupTaskSchedulerService,
          useValue: mockSchedulerService as unknown as GroupTaskSchedulerService,
        },
        { provide: GroupResolverService, useValue: mockGroupResolverService },
        { provide: NotificationSenderService, useValue: mockNotificationSenderService },
        { provide: CompletionService, useValue: mockCompletionService },
        { provide: getQueueToken(GROUP_TASK_QUEUE_NAME), useValue: queueMock },
      ],
    })
      .overrideGuard(ApiTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<GroupTaskController>(GroupTaskController);
  });

  describe('trigger', () => {
    it('should call scheduler.executeTask with forceEnabled + manual trigger', async () => {
      const mockStrategy = { type: GroupTaskType.ORDER_GRAB };
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(mockStrategy);
      (mockSchedulerService.executeTask as jest.Mock).mockResolvedValue({
        execId: 'exec-123',
      });

      const result = await controller.trigger(GroupTaskType.ORDER_GRAB);

      expect(mockSchedulerService.getStrategy).toHaveBeenCalledWith(GroupTaskType.ORDER_GRAB);
      expect(mockSchedulerService.executeTask).toHaveBeenCalledWith(mockStrategy, {
        forceEnabled: true,
        trigger: 'manual',
      });
      expect(result).toMatchObject({
        success: true,
        execId: 'exec-123',
        type: GroupTaskType.ORDER_GRAB,
      });
    });

    it('should return skipped=disabled when scheduler returns disabled', async () => {
      const mockStrategy = { type: GroupTaskType.ORDER_GRAB };
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(mockStrategy);
      (mockSchedulerService.executeTask as jest.Mock).mockResolvedValue({
        execId: null,
        skipped: 'disabled',
      });

      const result = await controller.trigger(GroupTaskType.ORDER_GRAB);

      expect(result).toMatchObject({
        success: false,
        skipped: 'disabled',
      });
    });

    it('should throw HttpException BAD_REQUEST with invalid type', async () => {
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(null);

      await expect(controller.trigger('invalid-type' as GroupTaskType)).rejects.toThrow(
        HttpException,
      );

      try {
        await controller.trigger('invalid-type' as GroupTaskType);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });
  });

  describe('retry', () => {
    it('should retry failed send jobs of the requested type', async () => {
      const retryFnA = jest.fn().mockResolvedValue(undefined);
      const retryFnB = jest.fn().mockResolvedValue(undefined);
      queueMock.getFailed.mockResolvedValue([
        {
          id: 'send-A',
          name: GroupTaskJobName.SEND,
          data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群A' } },
          retry: retryFnA,
        },
        {
          id: 'plan-B',
          name: GroupTaskJobName.PLAN,
          data: { type: GroupTaskType.PART_TIME_JOB },
          retry: jest.fn(),
        },
        {
          id: 'send-C',
          name: GroupTaskJobName.SEND,
          data: { type: GroupTaskType.ORDER_GRAB, group: { groupName: '群C' } },
          retry: jest.fn(),
        },
        {
          id: 'send-D',
          name: GroupTaskJobName.SEND,
          data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群D' } },
          retry: retryFnB,
        },
      ]);

      const result = await controller.retry(GroupTaskType.PART_TIME_JOB);

      expect(retryFnA).toHaveBeenCalledTimes(1);
      expect(retryFnB).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        success: true,
        retriedCount: 2,
        failedToRetryCount: 0,
      });
      expect(result.retried.map((r) => r.groupName)).toEqual(['群A', '群D']);
    });

    it('should report per-job failures without aborting the whole retry sweep', async () => {
      queueMock.getFailed.mockResolvedValue([
        {
          id: 'send-ok',
          name: GroupTaskJobName.SEND,
          data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群OK' } },
          retry: jest.fn().mockResolvedValue(undefined),
        },
        {
          id: 'send-bad',
          name: GroupTaskJobName.SEND,
          data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群BAD' } },
          retry: jest.fn().mockRejectedValue(new Error('bull busy')),
        },
      ]);

      const result = await controller.retry(GroupTaskType.PART_TIME_JOB);

      expect(result).toMatchObject({
        success: false,
        retriedCount: 1,
        failedToRetryCount: 1,
      });
      expect(result.errors[0]).toMatchObject({ jobId: 'send-bad', error: 'bull busy' });
    });
  });

  describe('status', () => {
    it('should aggregate per-state counts and list failed send groups', async () => {
      queueMock.getWaiting.mockResolvedValue([
        {
          id: 'w-1',
          name: GroupTaskJobName.PREPARE,
          data: { type: GroupTaskType.PART_TIME_JOB },
        },
      ]);
      queueMock.getDelayed.mockResolvedValue([
        { id: 'd-1', name: GroupTaskJobName.SEND, data: { type: GroupTaskType.PART_TIME_JOB } },
        { id: 'd-2', name: GroupTaskJobName.SEND, data: { type: GroupTaskType.ORDER_GRAB } },
      ]);
      queueMock.getFailed.mockResolvedValue([
        {
          id: 'f-1',
          name: GroupTaskJobName.SEND,
          data: { type: GroupTaskType.PART_TIME_JOB, group: { groupName: '群F' } },
          failedReason: '企微限流',
          attemptsMade: 3,
        },
      ]);

      const result = await controller.status(GroupTaskType.PART_TIME_JOB);

      expect(result.counts.waiting).toBe(1);
      expect(result.counts.delayed).toBe(1);
      expect(result.counts.failed).toBe(1);
      expect(result.failedSendGroups).toEqual([
        {
          jobId: 'f-1',
          groupName: '群F',
          failedReason: '企微限流',
          attemptsMade: 3,
        },
      ]);
    });
  });
});
