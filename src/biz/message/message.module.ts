import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { ChatSessionService } from './chat-session.service';
import { MessageProcessingService } from './message-processing.service';

@Module({
  controllers: [MessageController],
  providers: [ChatSessionService, MessageProcessingService],
  exports: [ChatSessionService, MessageProcessingService],
})
export class BizMessageModule {}
