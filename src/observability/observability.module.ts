import { Global, Module } from '@nestjs/common';
import { NotificationModule } from '@notification/notification.module';
import { LoggerObserver } from './logger-observer';
import { OBSERVER } from './observer.interface';
import { IncidentReporterService } from './incidents/incident-reporter.service';
import { ProcessExceptionMonitorService } from './runtime/process-exception-monitor.service';

@Global()
@Module({
  imports: [NotificationModule],
  providers: [
    { provide: OBSERVER, useClass: LoggerObserver },
    IncidentReporterService,
    ProcessExceptionMonitorService,
  ],
  exports: [OBSERVER, IncidentReporterService],
})
export class ObservabilityModule {}
