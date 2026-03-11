import { Injectable, Logger } from '@nestjs/common';
import { MonitoringMetadata } from './interfaces/monitoring.interface';
import { MessageTrackingService } from './services/message-tracking.service';

/**
 * 监控服务（基础追踪层）
 * 负责消息生命周期追踪，供核心业务流程调用。
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(private readonly trackingService: MessageTrackingService) {
    this.logger.log('监控基础服务已启动');
  }

  recordMessageReceived(
    messageId: string,
    chatId: string,
    userId?: string,
    userName?: string,
    messageContent?: string,
    metadata?: MonitoringMetadata,
    managerName?: string,
  ): void {
    this.trackingService.recordMessageReceived(
      messageId,
      chatId,
      userId,
      userName,
      messageContent,
      metadata,
      managerName,
    );
  }

  recordWorkerStart(messageId: string): void {
    this.trackingService.recordWorkerStart(messageId);
  }

  recordAiStart(messageId: string): void {
    this.trackingService.recordAiStart(messageId);
  }

  recordAiEnd(messageId: string): void {
    this.trackingService.recordAiEnd(messageId);
  }

  recordSendStart(messageId: string): void {
    this.trackingService.recordSendStart(messageId);
  }

  recordSendEnd(messageId: string): void {
    this.trackingService.recordSendEnd(messageId);
  }

  recordSuccess(
    messageId: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.trackingService.recordSuccess(messageId, metadata);
  }

  recordFailure(
    messageId: string,
    error: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.trackingService.recordFailure(messageId, error, metadata);
  }
}
