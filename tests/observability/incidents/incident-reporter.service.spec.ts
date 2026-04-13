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

  it('should forward system exception context to AlertNotifierService', async () => {
    const error = new Error('db unavailable');

    await service.notify({
      source: 'cron:data-cleanup',
      error,
      title: '数据清理失败',
      errorType: 'cron_job_failed',
      level: AlertLevel.ERROR,
      apiEndpoint: 'POST /cleanup',
      extra: {
        dryRun: false,
      },
    });

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'cron_job_failed',
        title: '数据清理失败',
        error,
        level: AlertLevel.ERROR,
        scenario: 'cron:data-cleanup',
        apiEndpoint: 'POST /cleanup',
        extra: expect.objectContaining({
          source: 'cron:data-cleanup',
          dryRun: false,
        }),
        details: expect.objectContaining({
          name: 'Error',
          stack: expect.stringContaining('db unavailable'),
        }),
      }),
    );
  });

  it('should default title and level when omitted', async () => {
    await service.notify({
      source: 'process:unhandledRejection',
      error: new Error('boom'),
    });

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '系统异常: process:unhandledRejection',
        level: AlertLevel.ERROR,
      }),
    );
  });

  it('should omit details for non-Error values', async () => {
    await service.notify({
      source: 'process:unhandledRejection',
      error: 'string failure',
    });

    expect(alertNotifier.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        details: undefined,
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
      source: 'process:uncaughtException',
      error: new Error('boom'),
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(loggerErrorSpy).toHaveBeenCalledWith('发送系统异常告警失败: webhook rejected');
  });
});
