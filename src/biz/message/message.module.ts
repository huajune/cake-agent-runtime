import { Module } from '@nestjs/common';
import { FeishuModule } from '@infra/feishu/feishu.module';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { MessageProcessingRepository } from './repositories/message-processing.repository';
import { BookingRepository } from './repositories/booking.repository';
import { MessageController } from './message.controller';
import { ChatSessionService } from './services/chat-session.service';
import { MessageProcessingService } from './services/message-processing.service';
import { BookingService } from './services/booking.service';
import { BookingDetectionService } from './services/booking-detection.service';

@Module({
  imports: [FeishuModule],
  controllers: [MessageController],
  providers: [
    // repositories
    ChatMessageRepository,
    MessageProcessingRepository,
    BookingRepository,
    // services
    ChatSessionService,
    MessageProcessingService,
    BookingService,
    BookingDetectionService,
  ],
  exports: [ChatSessionService, MessageProcessingService, BookingService, BookingDetectionService],
})
export class BizMessageModule {}
