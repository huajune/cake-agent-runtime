import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

/**
 * 会话管理模块
 * 负责管理聊天会话列表和消息历史
 */
@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
