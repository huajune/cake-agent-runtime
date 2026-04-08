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
    it('fires executeTask with forceEnabled and returns accepted ack synchronously', () => {
      const mockStrategy = { fetchData: jest.fn(), buildMessage: jest.fn() };
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(mockStrategy);
      // 永不 resolve：证明 controller 不会等待 executeTask 完成
      const pending = new Promise(() => undefined);
      (mockSchedulerService.executeTask as jest.Mock).mockReturnValue(pending);

      const result = controller.trigger(GroupTaskType.ORDER_GRAB);

      expect(mockSchedulerService.getStrategy).toHaveBeenCalledWith(GroupTaskType.ORDER_GRAB);
      expect(mockSchedulerService.executeTask).toHaveBeenCalledWith(mockStrategy, {
        forceEnabled: true,
      });
      expect(result).toEqual({
        type: GroupTaskType.ORDER_GRAB,
        status: 'accepted',
        message: expect.any(String),
      });
    });

    it('throws BAD_REQUEST for unknown task type', () => {
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(null);

      expect(() => controller.trigger('invalid-type' as GroupTaskType)).toThrow(HttpException);

      try {
        controller.trigger('invalid-type' as GroupTaskType);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
      }
    });

    it('swallows executeTask rejection (fire-and-forget, avoids unhandled rejection)', async () => {
      const mockStrategy = { fetchData: jest.fn(), buildMessage: jest.fn() };
      (mockSchedulerService.getStrategy as jest.Mock).mockReturnValue(mockStrategy);
      (mockSchedulerService.executeTask as jest.Mock).mockRejectedValue(new Error('boom'));

      // 触发后立即返回 ack，不应抛出
      const result = controller.trigger(GroupTaskType.ORDER_GRAB);
      expect(result.status).toBe('accepted');

      // 等待微任务队列排空，确认 .catch 吃掉了 rejection
      await new Promise((resolve) => setImmediate(resolve));
    });
  });
});
