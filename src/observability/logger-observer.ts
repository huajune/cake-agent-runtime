import { Injectable, Logger } from '@nestjs/common';
import { Observer, AgentEvent } from './observer.interface';

/**
 * 默认日志 Observer — 将事件写入 NestJS Logger
 */
@Injectable()
export class LoggerObserver implements Observer {
  private readonly logger = new Logger('AgentObserver');

  emit(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.logger.log(`Agent开始: userId=${event.userId}, scenario=${event.scenario}`);
        break;
      case 'agent_end':
        this.logger.log(
          `Agent完成: userId=${event.userId}, steps=${event.steps}, ` +
            `tokens=${event.totalTokens}, 耗时=${event.durationMs}ms`,
        );
        break;
      case 'agent_stream_timing':
        this.logger.log(
          `AI-Stream时延: trace=${event.messageId}, status=${event.status}, ` +
            `streamReady=${event.timeToStreamReadyMs ?? -1}ms, ` +
            `firstChunk=${event.timeToFirstChunkMs ?? -1}ms, ` +
            `firstReasoning=${event.timeToFirstReasoningMs ?? -1}ms, ` +
            `firstText=${event.timeToFirstTextMs ?? -1}ms, ` +
            `stream=${event.streamDurationMs ?? -1}ms, total=${event.totalDurationMs}ms, ` +
            `tokens=${event.totalTokens ?? 0}${event.error ? `, error=${event.error}` : ''}`,
        );
        break;
      case 'agent_error':
        this.logger.error(`Agent错误: userId=${event.userId}, ${event.error}`);
        break;
      case 'model_fallback':
        this.logger.warn(`模型降级: ${event.fromModel} → ${event.toModel} (${event.reason})`);
        break;
      case 'tool_call':
        this.logger.debug(`工具调用: ${event.toolName} (userId=${event.userId})`);
        break;
      case 'tool_error':
        this.logger.error(`工具错误: ${event.toolName}: ${event.error}`);
        break;
      case 'memory_recall':
        this.logger.debug(`记忆回忆: userId=${event.userId}, found=${event.found}`);
        break;
      case 'memory_store':
        this.logger.debug(`记忆存储: userId=${event.userId}, keys=[${event.keys.join(',')}]`);
        break;
      default:
        this.logger.debug(`事件: ${JSON.stringify(event)}`);
    }
  }
}
