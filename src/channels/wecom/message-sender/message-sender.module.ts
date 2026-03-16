import { Module } from '@nestjs/common';
import { MessageSenderController } from './message-sender.controller';
import { MessageSenderService } from './message-sender.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

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
