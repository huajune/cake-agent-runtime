import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

describe('IncidentReporterService', () => {
  let service: IncidentReporterService;
  let alertNotifier: jest.Mocked<AlertNotifierService>;

  beforeEach(() => {
    alertNotifier = {
      sendAlert: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<AlertNotifierService>;

    service = new IncidentReporterService(alertNotifier);
  });

  it('should forward structured incident context to AlertNotifierService', async () => {
    const error = new Error('db unavailable');

    await service.notify({
      source: {
        subsystem: 'monitoring',
        component: 'DataCleanupService',
        action: 'cleanupExpiredData',
        trigger: 'cron',
      },
      error,
      summary: '数据清理失败',
      code: 'cron.job_failed',
      severity: AlertLevel.ERROR,
      scope: {
        scenario: 'cron:data-cleanup',
      },
      diagnostics: {
        payload: {
          dryRun: false,
        },
      },
    });

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'cron.job_failed',
        summary: '数据清理失败',
        severity: AlertLevel.ERROR,
        source: expect.objectContaining({
          subsystem: 'monitoring',
          component: 'DataCleanupService',
          action: 'cleanupExpiredData',
        }),
        scope: expect.objectContaining({
          scenario: 'cron:data-cleanup',
        }),
        diagnostics: expect.objectContaining({
          error,
          errorMessage: 'db unavailable',
          errorName: 'Error',
          stack: expect.stringContaining('db unavailable'),
          payload: expect.objectContaining({
            dryRun: false,
          }),
        }),
        dedupe: expect.objectContaining({
          key: 'cron.job_failed:monitoring:DataCleanupService:cleanupExpiredData',
        }),
      }),
    );
  });

  it('should default summary and severity when omitted', async () => {
    await service.notify({
      source: {
        subsystem: 'observability',
        component: 'ProcessExceptionMonitorService',
        action: 'unhandledRejection',
        trigger: 'process',
      },
      error: new Error('boom'),
    });

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: '系统异常: ProcessExceptionMonitorService.unhandledRejection',
        severity: AlertLevel.ERROR,
      }),
    );
  });

  it('should omit stack for non-Error values', async () => {
    await service.notify({
      source: {
        subsystem: 'observability',
        component: 'ProcessExceptionMonitorService',
        action: 'unhandledRejection',
        trigger: 'process',
      },
      error: 'string failure',
    });

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          error: 'string failure',
          errorMessage: 'string failure',
          stack: undefined,
        }),
      }),
    );
  });

  it('should swallow async notify failures and log them', async () => {
    const loggerErrorSpy = jest
      .spyOn(
        ((service as unknown as { logger: { error: (msg: string) => void } }).logger),
        'error',
      )
      .mockImplementation();
    alertNotifier.sendAlert.mockRejectedValueOnce(new Error('webhook rejected'));

    service.notifyAsync({
      source: {
        subsystem: 'observability',
        component: 'ProcessExceptionMonitorService',
        action: 'uncaughtException',
        trigger: 'process',
      },
      error: new Error('boom'),
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(loggerErrorSpy).toHaveBeenCalledWith('发送系统异常告警失败: webhook rejected');
  });
});
