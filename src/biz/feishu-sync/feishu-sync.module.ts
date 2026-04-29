import { Module } from '@nestjs/common';
import { BizMessageModule } from '@biz/message/message.module';
import { FeishuBitableSyncService } from './bitable-sync.service';
import { ChatRecordSyncService } from './chat-record.service';
import { FeishuSyncController } from './feishu-sync.controller';
import { FeedbackSourceTraceService } from './feedback-source-trace.service';

/**
 * 飞书同步模块
 *
 * 将业务数据（消息处理记录、聊天记录）同步到飞书多维表格。
 * 依赖 BizMessageModule 获取数据，依赖 FeishuModule（全局）的 API 服务写入飞书。
 */
@Module({
  imports: [BizMessageModule],
  controllers: [FeishuSyncController],
  providers: [FeishuBitableSyncService, ChatRecordSyncService, FeedbackSourceTraceService],
  exports: [FeishuBitableSyncService, ChatRecordSyncService],
})
export class FeishuSyncModule {}
