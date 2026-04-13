import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { ProcessExceptionMonitorService } from '@observability/runtime/process-exception-monitor.service';

describe('ProcessExceptionMonitorService', () => {
  let service: ProcessExceptionMonitorService;
  let incidentReporter: jest.Mocked<IncidentReporterService>;

  beforeEach(() => {
    incidentReporter = {
      notifyAsync: jest.fn(),
    } as unknown as jest.Mocked<IncidentReporterService>;
    service = new ProcessExceptionMonitorService(incidentReporter);
    jest
      .spyOn(
        ((service as unknown as {
          logger: { error: (...args: unknown[]) => void; log: (...args: unknown[]) => void };
        }).logger),
        'error',
      )
      .mockImplementation();
    jest
      .spyOn(
        ((service as unknown as {
          logger: { error: (...args: unknown[]) => void; log: (...args: unknown[]) => void };
        }).logger),
        'log',
      )
      .mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should register process listeners only once', () => {
    const onSpy = jest.spyOn(process, 'on').mockImplementation(() => process);

    service.onModuleInit();
    service.onModuleInit();

    expect(onSpy).toHaveBeenCalledTimes(2);
    expect(onSpy).toHaveBeenNthCalledWith(1, 'uncaughtException', expect.any(Function));
    expect(onSpy).toHaveBeenNthCalledWith(2, 'unhandledRejection', expect.any(Function));
  });

  it('should unregister listeners on module destroy', () => {
    jest.spyOn(process, 'on').mockImplementation(() => process);
    const offSpy = jest.spyOn(process, 'off').mockImplementation(() => process);

    service.onModuleInit();
    service.onModuleDestroy();

    expect(offSpy).toHaveBeenCalledTimes(2);
    expect(offSpy).toHaveBeenNthCalledWith(
      1,
      'uncaughtException',
      (service as unknown as { handleUncaughtException: (err: Error) => void }).handleUncaughtException,
    );
    expect(offSpy).toHaveBeenNthCalledWith(
      2,
      'unhandledRejection',
      (service as unknown as { handleUnhandledRejection: (reason: unknown) => void })
        .handleUnhandledRejection,
    );
  });

  it('should not try to unregister listeners from a different instance', () => {
    jest.spyOn(process, 'on').mockImplementation(() => process);
    const offSpy = jest.spyOn(process, 'off').mockImplementation(() => process);
    const anotherService = new ProcessExceptionMonitorService(incidentReporter);

    service.onModuleInit();
    anotherService.onModuleDestroy();

    expect(offSpy).not.toHaveBeenCalled();
  });

  it('should report uncaught exceptions as critical incidents', () => {
    const error = new Error('boom');

    (service as unknown as { handleUncaughtException: (err: Error) => void }).handleUncaughtException(error);

    expect(incidentReporter.notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          subsystem: 'observability',
          component: 'ProcessExceptionMonitorService',
          action: 'uncaughtException',
          trigger: 'process',
        }),
        code: 'system.process_uncaught_exception',
        summary: '未捕获进程异常',
        error,
        severity: AlertLevel.CRITICAL,
        diagnostics: expect.objectContaining({
          payload: expect.objectContaining({ pid: process.pid }),
        }),
      }),
    );
  });

  it('should wrap non-Error rejection reasons before reporting', () => {
    (service as unknown as { handleUnhandledRejection: (reason: unknown) => void }).handleUnhandledRejection('promise failed');

    expect(incidentReporter.notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          subsystem: 'observability',
          component: 'ProcessExceptionMonitorService',
          action: 'unhandledRejection',
          trigger: 'process',
        }),
        code: 'system.process_unhandled_rejection',
        summary: '未处理 Promise 拒绝',
        error: expect.objectContaining({
          message: 'promise failed',
        }),
        severity: AlertLevel.CRITICAL,
      }),
    );
  });
});
