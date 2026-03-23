import { ConsoleLogger, Injectable, Scope } from '@nestjs/common';
import { LoggerGateway } from './logger.gateway';
import { LogEntry } from './logger.interface';

/**
 * 自定义 Logger 服务
 *
 * 继承 NestJS 的 ConsoleLogger，拦截所有日志并广播到 WebSocket
 * 这样不需要修改任何现有代码，所有使用 Logger 的地方都会自动推送到 Dashboard
 */
@Injectable({ scope: Scope.TRANSIENT })
export class CustomLoggerService extends ConsoleLogger {
  private static gateway: LoggerGateway | null = null;

  /**
   * 设置 WebSocket 网关（由模块初始化时调用）
   */
  static setGateway(gateway: LoggerGateway) {
    CustomLoggerService.gateway = gateway;
  }

  log(message: string, context?: string) {
    super.log(message, context);
    this.broadcast('log', message, context);
  }

  error(message: string, trace?: string, context?: string) {
    super.error(message, trace, context);
    this.broadcast('error', message, context, trace);
  }

  warn(message: string, context?: string) {
    super.warn(message, context);
    this.broadcast('warn', message, context);
  }

  debug(message: string, context?: string) {
    super.debug(message, context);
    this.broadcast('debug', message, context);
  }

  verbose(message: string, context?: string) {
    super.verbose(message, context);
    this.broadcast('verbose', message, context);
  }

  private broadcast(level: LogEntry['level'], message: unknown, context?: unknown, trace?: string) {
    if (!CustomLoggerService.gateway) {
      return;
    }

    // 确保 message 是字符串
    const safeMessage =
      typeof message === 'string'
        ? message
        : typeof message === 'object' && message !== null
          ? JSON.stringify(message)
          : String(message);

    // 确保 context 是字符串
    const safeContext =
      typeof context === 'string'
        ? context
        : typeof context === 'object' && context !== null
          ? this.context || 'Application' // 如果 context 是对象，使用默认 context
          : this.context || 'Application';

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      context: safeContext,
      message: safeMessage,
      trace,
    };

    CustomLoggerService.gateway.broadcast(entry);
  }
}
