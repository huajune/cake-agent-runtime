import { AlertLogPersisterService } from '@biz/monitoring/services/tracking/alert-log.persister';
import type { AlertLogEntry } from '@notification/types/alert-log-persister.interface';

describe('AlertLogPersisterService', () => {
  const mockRepo = {
    saveErrorLog: jest.fn<Promise<void>, [unknown]>(),
  };

  let service: AlertLogPersisterService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRepo.saveErrorLog.mockResolvedValue(undefined);
    service = new AlertLogPersisterService(mockRepo as never);
  });

  const entry: AlertLogEntry = {
    messageId: 'msg-1',
    timestamp: 1_700_000_000_000,
    error: 'feishu 5xx',
    code: 'group_task.preview_failed',
    severity: 'error',
    summary: '群任务预览失败',
    subsystem: 'group-task',
    component: 'NotificationSenderService',
    action: 'sendPreview',
    dedupeKey: 'group_task.preview_failed',
    throttled: false,
    delivered: true,
  };

  it('maps AlertLogEntry to the error-log record and forces alertType=system', async () => {
    await service.persist(entry);

    expect(mockRepo.saveErrorLog).toHaveBeenCalledTimes(1);
    expect(mockRepo.saveErrorLog).toHaveBeenCalledWith({
      messageId: 'msg-1',
      timestamp: 1_700_000_000_000,
      error: 'feishu 5xx',
      alertType: 'system',
      subsystem: 'group-task',
      component: 'NotificationSenderService',
      action: 'sendPreview',
      severity: 'error',
      summary: '群任务预览失败',
      code: 'group_task.preview_failed',
      dedupeKey: 'group_task.preview_failed',
      throttled: false,
      delivered: true,
    });
  });

  it('passes through throttled/delivered flags (e.g. throttled alert without messageId)', async () => {
    await service.persist({
      timestamp: 1_700_000_000_001,
      error: 'cron failed',
      code: 'cron.cleanup_failed',
      subsystem: 'monitoring',
      throttled: true,
      delivered: false,
    });

    expect(mockRepo.saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: undefined,
        throttled: true,
        delivered: false,
        alertType: 'system',
      }),
    );
  });

  it('swallows repository errors so alert delivery is never blocked', async () => {
    mockRepo.saveErrorLog.mockRejectedValueOnce(new Error('DB down'));
    await expect(service.persist(entry)).resolves.toBeUndefined();
  });
});
