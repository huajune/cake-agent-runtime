import { Injectable, Logger } from '@nestjs/common';
import { AgentEvent, Observer } from './observer.interface';
import { LoggerObserver } from './logger-observer';
import { PersistingObserver } from './persisting-observer';

@Injectable()
export class CompositeObserver implements Observer {
  private readonly logger = new Logger(CompositeObserver.name);

  constructor(
    private readonly loggerObserver: LoggerObserver,
    private readonly persistingObserver: PersistingObserver,
  ) {}

  emit(event: AgentEvent): void {
    for (const observer of [this.loggerObserver, this.persistingObserver]) {
      try {
        observer.emit(event);
      } catch (error) {
        this.logger.warn(
          `[observer] ${observer.constructor.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
