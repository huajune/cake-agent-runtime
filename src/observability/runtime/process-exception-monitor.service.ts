import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

@Injectable()
export class ProcessExceptionMonitorService implements OnModuleInit, OnModuleDestroy {
  private static listenersRegistered = false;

  private readonly logger = new Logger(ProcessExceptionMonitorService.name);

  constructor(private readonly incidentReporter: IncidentReporterService) {}

  onModuleInit(): void {
    if (ProcessExceptionMonitorService.listenersRegistered) {
      return;
    }

    process.on('uncaughtException', this.handleUncaughtException);
    process.on('unhandledRejection', this.handleUnhandledRejection);
    ProcessExceptionMonitorService.listenersRegistered = true;

    this.logger.log('进程级异常监控已注册');
  }

  onModuleDestroy(): void {
    if (!ProcessExceptionMonitorService.listenersRegistered) {
      return;
    }

    process.off('uncaughtException', this.handleUncaughtException);
    process.off('unhandledRejection', this.handleUnhandledRejection);
    ProcessExceptionMonitorService.listenersRegistered = false;
  }

  private readonly handleUncaughtException = (error: Error): void => {
    this.logger.error(`捕获到未处理异常: ${error.message}`, error.stack);
    this.incidentReporter.notifyAsync({
      source: 'process:uncaughtException',
      errorType: 'uncaught_exception',
      title: '未捕获进程异常',
      error,
      level: AlertLevel.CRITICAL,
      extra: {
        pid: process.pid,
      },
    });
  };

  private readonly handleUnhandledRejection = (reason: unknown): void => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.logger.error(`捕获到未处理 Promise 拒绝: ${error.message}`, error.stack);
    this.incidentReporter.notifyAsync({
      source: 'process:unhandledRejection',
      errorType: 'unhandled_rejection',
      title: '未处理 Promise 拒绝',
      error,
      level: AlertLevel.CRITICAL,
      extra: {
        pid: process.pid,
      },
    });
  };
}
