import { Module } from '@nestjs/common';
import { MessageSenderController } from './message-sender.controller';
import { MessageSenderService } from './message-sender.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

/**
 * 消息发送模块
 * 负责所有消息发送相关功能
 */
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [MessageSenderController],
  providers: [MessageSenderService],
  exports: [MessageSenderService],
})
export class MessageSenderModule {}
