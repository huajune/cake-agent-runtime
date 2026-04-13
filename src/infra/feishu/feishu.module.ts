import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FeishuApiService } from './services/api.service';
import { FeishuBitableApiService } from './services/bitable-api.service';
import { FeishuWebhookService } from './services/webhook.service';
import { FeishuCardBuilderService } from './services/card-builder.service';
import { FeishuController } from './feishu.controller';

/**
 * 飞书基础设施模块（纯 infra，无 biz 依赖）
 *
 * 提供飞书基础 API 能力：
 * - 基础 API 服务（FeishuApiService）：Token 管理、HTTP 请求
 * - 多维表格 API（FeishuBitableApiService）：Bitable CRUD 操作
 * - Webhook 基础能力（FeishuWebhookService / FeishuCardBuilderService）
 *
 * 注意：数据同步服务（聊天记录→飞书 BiTable）在 biz/feishu-sync 模块中。
 */
@Global()
@Module({
  imports: [ConfigModule, ScheduleModule.forRoot()],
  controllers: [FeishuController],
  providers: [
    FeishuApiService,
    FeishuBitableApiService,
    FeishuWebhookService,
    FeishuCardBuilderService,
  ],
  exports: [
    FeishuApiService,
    FeishuBitableApiService,
    FeishuWebhookService,
    FeishuCardBuilderService,
  ],
})
export class FeishuModule {}
