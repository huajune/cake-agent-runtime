import { Test, TestingModule } from '@nestjs/testing';
import { GroupTaskController } from '@biz/group-task/group-task.controller';
import { GroupTaskAdminService } from '@biz/group-task/services/group-task-admin.service';
import { GroupTaskType } from '@biz/group-task/group-task.types';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';

describe('GroupTaskController', () => {
  let controller: GroupTaskController;

  const adminService = {
    trigger: jest.fn(),
    retry: jest.fn(),
    status: jest.fn(),
    testSend: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GroupTaskController],
      providers: [{ provide: GroupTaskAdminService, useValue: adminService }],
    })
      .overrideGuard(ApiTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<GroupTaskController>(GroupTaskController);
    jest.clearAllMocks();
  });

  it('delegates trigger to admin service', async () => {
    adminService.trigger.mockResolvedValueOnce({ success: true, execId: 'exec-1' });

    await expect(controller.trigger(GroupTaskType.ORDER_GRAB)).resolves.toEqual({
      success: true,
      execId: 'exec-1',
    });

    expect(adminService.trigger).toHaveBeenCalledWith(GroupTaskType.ORDER_GRAB);
  });

  it('delegates retry to admin service', async () => {
    adminService.retry.mockResolvedValueOnce({ success: true, retriedCount: 1 });

    await expect(controller.retry(GroupTaskType.PART_TIME_JOB)).resolves.toEqual({
      success: true,
      retriedCount: 1,
    });

    expect(adminService.retry).toHaveBeenCalledWith(GroupTaskType.PART_TIME_JOB);
  });

  it('delegates status to admin service', async () => {
    adminService.status.mockResolvedValueOnce({ type: GroupTaskType.WORK_TIPS });

    await expect(controller.status(GroupTaskType.WORK_TIPS)).resolves.toEqual({
      type: GroupTaskType.WORK_TIPS,
    });

    expect(adminService.status).toHaveBeenCalledWith(GroupTaskType.WORK_TIPS);
  });

  it('delegates test-send to admin service', async () => {
    const body = { type: GroupTaskType.ORDER_GRAB, groupName: '测试群' };
    adminService.testSend.mockResolvedValueOnce({ success: true });

    await expect(controller.testSend(body)).resolves.toEqual({ success: true });

    expect(adminService.testSend).toHaveBeenCalledWith(body);
  });
});
