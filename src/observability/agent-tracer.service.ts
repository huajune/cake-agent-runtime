import { toErrorMessage } from '@infra/utils/error.util';
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

    // 事件显式写 `userId: undefined` 不得盖掉请求上下文里的值：先剔除 undefined 再合并。
    const explicit = Object.fromEntries(
      Object.entries(event).filter(([, value]) => value !== undefined),
    ) as AgentEvent;
    const enriched = {
      ...this.requestContext.get(),
      timestamp: Date.now(),
      ...explicit,
    };

    try {
      this.observer.emit(enriched);
    } catch (error) {
      this.logger.warn(`[agent-tracer] observer dispatch failed: ${toErrorMessage(error)}`);
    }
  }
}
