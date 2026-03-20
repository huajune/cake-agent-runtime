import { Module } from '@nestjs/common';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { MessageProcessingRepository } from './repositories/message-processing.repository';
import { BookingRepository } from './repositories/booking.repository';
import { MessageController } from './message.controller';
import { ChatSessionService } from './services/chat-session.service';
import { MessageProcessingService } from './services/message-processing.service';
import { MonitoringRecordRepository } from '@biz/monitoring/repositories/record.repository';

@Module({
  controllers: [MessageController],
  providers: [
    // repositories
    ChatMessageRepository,
    MessageProcessingRepository,
    BookingRepository,
    MonitoringRecordRepository,
    // services
    ChatSessionService,
    MessageProcessingService,
  ],
  exports: [
    ChatSessionService,
    MessageProcessingService,
    ChatMessageRepository,
    MessageProcessingRepository,
    BookingRepository,
    MonitoringRecordRepository,
  ],
})
export class BizMessageModule {}
