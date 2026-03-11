import { Module } from '@nestjs/common';
import {
  ChatMessageRepository,
  MessageProcessingRepository,
  BookingRepository,
} from './repositories';
import { MessageController } from './message.controller';
import { ChatSessionService, MessageProcessingService } from './services';

@Module({
  controllers: [MessageController],
  providers: [
    // repositories
    ChatMessageRepository,
    MessageProcessingRepository,
    BookingRepository,
    // services
    ChatSessionService,
    MessageProcessingService,
  ],
  exports: [ChatSessionService, MessageProcessingService],
})
export class BizMessageModule {}
