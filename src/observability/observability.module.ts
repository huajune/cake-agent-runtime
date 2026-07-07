import { Global, Module } from '@nestjs/common';
import { NotificationModule } from '@notification/notification.module';
import { AgentTracerService } from './agent-tracer.service';
import { CompositeObserver } from './composite-observer';
import { RequestContextService } from './context/request-context.service';
import { LoggerObserver } from './logger-observer';
import { OBSERVER } from './observer.interface';
import { PersistingObserver } from './persisting-observer';
import { IncidentReporterService } from './incidents/incident-reporter.service';
import { ProcessExceptionMonitorService } from './runtime/process-exception-monitor.service';

@Global()
@Module({
  imports: [NotificationModule],
  providers: [
    RequestContextService,
    AgentTracerService,
    LoggerObserver,
    PersistingObserver,
    CompositeObserver,
    { provide: OBSERVER, useExisting: CompositeObserver },
    IncidentReporterService,
    ProcessExceptionMonitorService,
  ],
  exports: [OBSERVER, AgentTracerService, RequestContextService, IncidentReporterService],
})
export class ObservabilityModule {}
