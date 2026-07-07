import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OBSERVER, type AgentEvent, type Observer } from './observer.interface';
import { RequestContextService } from './context/request-context.service';

@Injectable()
export class AgentTracerService {
  private readonly logger = new Logger(AgentTracerService.name);

  constructor(
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(OBSERVER)
    private readonly observer?: Observer,
  ) {}

  emit(event: AgentEvent): void {
    if (!this.observer) return;

    const enriched = {
      ...this.requestContext.get(),
      timestamp: Date.now(),
      ...event,
    };

    try {
      this.observer.emit(enriched);
    } catch (error) {
      this.logger.warn(
        `[agent-tracer] observer dispatch failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
