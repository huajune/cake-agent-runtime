import { MessageWorkerManagerService } from '@channels/wecom/message/runtime/message-worker-manager.service';

describe('MessageWorkerManagerService', () => {
  const systemConfigService = {
    getSystemConfig: jest.fn(),
    updateSystemConfig: jest.fn(),
    getMessageMergeEnabled: jest.fn(),
  };

  let service: MessageWorkerManagerService;

  beforeEach(() => {
    jest.clearAllMocks();
    systemConfigService.getSystemConfig.mockResolvedValue(null);
    systemConfigService.updateSystemConfig.mockResolvedValue(undefined);
    systemConfigService.getMessageMergeEnabled.mockResolvedValue(true);
    service = new MessageWorkerManagerService(systemConfigService as never);
  });

  it('should clamp initialized concurrency within the supported range', async () => {
    systemConfigService.getSystemConfig.mockResolvedValueOnce({ workerConcurrency: 99 });

    await service.initialize();

    expect(service.getCurrentConcurrency()).toBe(20);
    expect(service.getRegistrationConcurrency()).toBe(20);
  });

  it('should queue execution until a slot is released', async () => {
    await service.setConcurrency(1);
    await service.acquireExecutionSlot();

    let acquiredSecondSlot = false;
    const secondSlot = service.acquireExecutionSlot().then(() => {
      acquiredSecondSlot = true;
    });

    await Promise.resolve();
    expect(acquiredSecondSlot).toBe(false);

    service.releaseExecutionSlot();
    await secondSlot;
    expect(acquiredSecondSlot).toBe(true);
  });

  it('should reject out-of-range concurrency updates', async () => {
    await expect(service.setConcurrency(0)).resolves.toEqual({
      success: false,
      message: '并发数必须在 1-20 之间',
      previousConcurrency: 4,
      currentConcurrency: 4,
    });
    expect(systemConfigService.updateSystemConfig).not.toHaveBeenCalled();
  });

  it('should keep the previous concurrency when persistence fails', async () => {
    await service.setConcurrency(6);
    systemConfigService.updateSystemConfig.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(service.setConcurrency(7)).resolves.toEqual({
      success: false,
      message: '修改失败: db unavailable',
      previousConcurrency: 6,
      currentConcurrency: 6,
    });
    expect(service.getCurrentConcurrency()).toBe(6);
  });
});
