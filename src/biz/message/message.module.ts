import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { ChatSessionService, MessageProcessingService } from './services';

@Module({
  controllers: [MessageController],
  providers: [ChatSessionService, MessageProcessingService],
  exports: [ChatSessionService, MessageProcessingService],
})
export class BizMessageModule {}
