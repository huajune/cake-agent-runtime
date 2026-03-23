import { Global, Module, OnModuleInit } from '@nestjs/common';
import { LoggerGateway } from './logger.gateway';
import { CustomLoggerService } from './custom-logger.service';

/**
 * 日志模块
 *
 * 提供实时日志可视化功能（仅开发环境）
 * - WebSocket 推送日志到 Dashboard
 * - 环形缓冲区保留最近 200 条日志
 * - 最多 5 个客户端连接
 */
@Global()
@Module({
  providers: [LoggerGateway, CustomLoggerService],
  exports: [LoggerGateway, CustomLoggerService],
})
export class LoggerModule implements OnModuleInit {
  constructor(private readonly gateway: LoggerGateway) {}

  onModuleInit() {
    // 将 Gateway 注入到 CustomLoggerService
    CustomLoggerService.setGateway(this.gateway);

    if (process.env.NODE_ENV !== 'production') {
      console.log('[LoggerModule] 实时日志推送已启用 (WebSocket /logs)');
    }
  }
}
