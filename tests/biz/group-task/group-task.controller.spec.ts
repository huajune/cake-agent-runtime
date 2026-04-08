import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { GroupTaskController } from '@biz/group-task/group-task.controller';
import { GroupTaskSchedulerService } from '@biz/group-task/services/group-task-scheduler.service';
import { GroupResolverService } from '@biz/group-task/services/group-resolver.service';
import { NotificationSenderService } from '@biz/group-task/services/notification-sender.service';
import { CompletionService } from '@agent/completion.service';
import { GroupTaskType } from '@biz/group-task/group-task.types';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';

describe('GroupTaskController', () => {
  let controller: GroupTaskController;
  let mockSchedulerService: Partial<GroupTaskSchedulerService>;
  const mockGroupResolverService = { findGroupByName: jest.fn() };
  const mockNotificationSenderService = { sendToGroup: jest.fn(), sendTextToGroup: jest.fn() };
  const mockCompletionService = { generateSimple: jest.fn() };

  beforeEach(async () => {
    mockSchedulerService = {
      getStrategy: jest.fn(),
      executeTask: jest.fn(),
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
      ],
    })
      .overrideGuard(ApiTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<GroupTaskController>(GroupTaskController);
  });

  describe('trigger', () => {
    it('should call scheduler.executeTask with forceEnabled only', async () => {
      const mockStrategy = { fetchData: jest.fn(), buildMessage: jest.fn() };
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(
        mockStrategy,
      );
      const now = new Date();
      (mockSchedulerService.executeTask as jest.Mock).mockResolvedValue({
        type: GroupTaskType.ORDER_GRAB,
        totalGroups: 3,
        successCount: 2,
        failedCount: 1,
        skippedCount: 0,
        errors: [],
        details: [],
        startTime: now,
        endTime: now,
      });

      const result = await controller.trigger(GroupTaskType.ORDER_GRAB);

      expect(mockSchedulerService.getStrategy).toHaveBeenCalledWith(
        GroupTaskType.ORDER_GRAB,
      );
      expect(mockSchedulerService.executeTask).toHaveBeenCalledWith(
        mockStrategy,
        { forceEnabled: true },
      );
      expect(result).toBeDefined();
    });

    it('should throw HttpException BAD_REQUEST with invalid type', async () => {
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(null);

      await expect(
        controller.trigger('invalid-type' as GroupTaskType),
      ).rejects.toThrow(HttpException);

      try {
        await controller.trigger('invalid-type' as GroupTaskType);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(
          HttpStatus.BAD_REQUEST,
        );
      }
    });

    it('should return result summary from executeTask', async () => {
      const mockStrategy = { fetchData: jest.fn(), buildMessage: jest.fn() };
      const now = new Date();
      const expectedResult = {
        type: GroupTaskType.ORDER_GRAB,
        totalGroups: 5,
        successCount: 5,
        failedCount: 0,
        skippedCount: 0,
        errors: [],
        details: [],
        startTime: now,
        endTime: now,
      };

      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(
        mockStrategy,
      );
      (mockSchedulerService.executeTask as jest.Mock).mockResolvedValue(
        expectedResult,
      );

      const result = await controller.trigger(GroupTaskType.ORDER_GRAB);

      expect(result.totalGroups).toBe(5);
      expect(result.successCount).toBe(5);
      expect(result.durationMs).toBe(0);
    });
  });
});
