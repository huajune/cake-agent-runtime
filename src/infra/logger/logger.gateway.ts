import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { LogEntry } from './logger.interface';

export { LogEntry };

/**
 * WebSocket 日志网关
 *
 * 仅在开发环境启用，用于实时推送日志到 Dashboard
 * 生产环境使用部署平台的日志功能
 */
@WebSocketGateway({
  namespace: '/logs',
  cors: {
    origin: '*',
    credentials: true,
  },
})
export class LoggerGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private connectedClients = 0;
  private readonly MAX_CLIENTS = 5;
  private readonly isDev = process.env.NODE_ENV !== 'production';

  // 环形缓冲区，保留最近 200 条日志
  private logBuffer: LogEntry[] = [];
  private readonly BUFFER_SIZE = 200;

  handleConnection(client: Socket) {
    if (!this.isDev) {
      client.disconnect();
      return;
    }

    if (this.connectedClients >= this.MAX_CLIENTS) {
      client.emit('error', { message: '连接数已达上限' });
      client.disconnect();
      return;
    }

    this.connectedClients++;
    console.log(`[LoggerGateway] 客户端连接 (${this.connectedClients}/${this.MAX_CLIENTS})`);

    // 发送历史日志
    client.emit('history', this.logBuffer);
  }

  handleDisconnect() {
    if (this.connectedClients > 0) {
      this.connectedClients--;
    }
    console.log(`[LoggerGateway] 客户端断开 (${this.connectedClients}/${this.MAX_CLIENTS})`);
  }

  /**
   * 广播日志到所有连接的客户端
   */
  broadcast(entry: LogEntry) {
    if (!this.isDev) {
      return;
    }

    // 无论是否有客户端连接，都添加到缓冲区（供后续连接时获取历史）
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.BUFFER_SIZE) {
      this.logBuffer.shift();
    }

    // 只有在有客户端连接时才广播
    if (this.connectedClients > 0) {
      this.server.emit('log', entry);
    }
  }

  /**
   * 获取连接状态
   */
  getStatus() {
    return {
      enabled: this.isDev,
      clients: this.connectedClients,
      maxClients: this.MAX_CLIENTS,
      bufferSize: this.logBuffer.length,
    };
  }
}
