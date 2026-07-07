import { Injectable, Logger } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import type {
  AgentEventPersister,
  AgentExecutionEvent,
} from '@observability/persistence/agent-event-persister.interface';
import { AgentExecutionEventRepository } from '../../repositories/agent-execution-event.repository';

@Injectable()
export class AgentExecutionEventPersisterService implements AgentEventPersister {
  private readonly logger = new Logger(AgentExecutionEventPersisterService.name);

  constructor(
    private readonly repository: AgentExecutionEventRepository,
    private readonly alertNotifier: AlertNotifierService,
  ) {}

  async persist(event: AgentExecutionEvent): Promise<void> {
    try {
      await this.repository.saveEvent(event);
    } catch (error) {
      this.logger.warn(
        `[agent-events] 写入失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.alertPersistFailure(event, error);
    }
  }

  private alertPersistFailure(event: AgentExecutionEvent, error: unknown): void {
    void this.alertNotifier
      .sendAlert({
        code: 'agent_execution_event_persist_failed',
        severity: AlertLevel.ERROR,
        summary: 'Agent 执行事件落库失败，该 trace 的执行下钻信息可能不完整',
        source: {
          subsystem: 'agent',
          component: 'observability',
          action: 'persist_execution_event',
        },
        scope: {
          messageId: event.traceId,
          chatId: event.chatId,
          userId: event.userId,
        },
        diagnostics: {
          error,
          payload: {
            eventType: event.type,
            scenario: event.scenario,
            callerKind: event.callerKind,
          },
        },
        dedupe: { key: `agent_execution_event_persist_failed:${event.type}` },
      })
      .catch((alertError: unknown) => {
        this.logger.warn(
          `[agent-events] 落库失败告警发送异常: ${
            alertError instanceof Error ? alertError.message : String(alertError)
          }`,
        );
      });
  }
}
