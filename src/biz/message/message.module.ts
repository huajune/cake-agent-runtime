import { Module } from '@nestjs/common';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { MessageProcessingRepository } from './repositories/message-processing.repository';
import { BookingRepository } from './repositories/booking.repository';
import { MessageController } from './message.controller';
import { ChatSessionService } from './services/chat-session.service';
import { MessageProcessingService } from './services/message-processing.service';

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
