import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AgentEvent, Observer } from './observer.interface';
import {
  AGENT_EVENT_PERSISTER,
  type AgentEventPersister,
} from './persistence/agent-event-persister.interface';

import { executionObservationReason } from './execution-event-policy';

@Injectable()
export class PersistingObserver implements Observer, OnApplicationBootstrap {
  private readonly logger = new Logger(PersistingObserver.name);
  private persister?: AgentEventPersister;

  constructor(private readonly moduleRef: ModuleRef) {}

  onApplicationBootstrap(): void {
    try {
      this.persister = this.moduleRef.get<AgentEventPersister>(AGENT_EVENT_PERSISTER, {
        strict: false,
      });
    } catch {
      this.logger.warn('AGENT_EVENT_PERSISTER 未注册，Agent 执行事件将仅写日志');
    }
  }

  emit(event: AgentEvent): void {
    if (!this.persister || !executionObservationReason(event.type, event)) return;

    void this.persister.persist(event).catch((error: unknown) => {
      this.logger.warn(`[agent-events] 持久化失败: ${toErrorMessage(error)}`);
    });
  }
}
