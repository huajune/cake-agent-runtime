import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FeishuApiService } from './services/feishu-api.service';
import { FeishuBitableApiService } from './services/feishu-bitable-api.service';
import { FeishuWebhookService } from './services/feishu-webhook.service';
import { FeishuAlertService } from './services/feishu-alert.service';
import { FeishuBookingService } from './services/feishu-booking.service';
import { FeishuBitableSyncService } from './services/feishu-bitable.service';
import { ChatRecordSyncService } from './services/feishu-chat-record.service';
import { FeishuController } from './feishu.controller';

/**
 * 飞书统一模块
 *
 * 整合所有飞书相关功能：
 * - 基础 API 服务（FeishuApiService）：Token 管理、HTTP 请求
 * - 多维表格 API（FeishuBitableApiService）：Bitable CRUD 操作
 * - Webhook 通知（告警、预约等）
 * - 多维表格同步（聊天记录、反馈等）
 *
 * 架构说明：
 * - FeishuApiService: 底层 API 服务，负责 Token 管理和 HTTP 请求
 * - FeishuBitableApiService: 中间层，封装 Bitable 通用操作
 * - 业务服务：使用上述服务完成具体业务逻辑
 */
@Global() // 设为全局模块，其他模块可直接注入
@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  controllers: [FeishuController],
  providers: [
    // 基础 API 服务
    FeishuApiService,
    FeishuBitableApiService,
    // 业务服务
    FeishuWebhookService,
    FeishuAlertService,
    FeishuBookingService,
    FeishuBitableSyncService,
    ChatRecordSyncService,
  ],
  exports: [
    // 导出 API 服务供其他模块使用
    FeishuApiService,
    FeishuBitableApiService,
    // 导出业务服务
    FeishuWebhookService,
    FeishuAlertService,
    FeishuBookingService,
    FeishuBitableSyncService,
    ChatRecordSyncService,
  ],
})
export class FeishuModule {}
