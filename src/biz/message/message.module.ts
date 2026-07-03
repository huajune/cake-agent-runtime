import { Module } from '@nestjs/common';
import { ChatMessageRepository } from './repositories/chat-message.repository';
import { GuardrailReviewRepository } from './repositories/guardrail-review.repository';
import { MessageProcessingRepository } from './repositories/message-processing.repository';
import { MessageController } from './message.controller';
import { ChatSessionService } from './services/chat-session.service';
import { GuardrailReviewService } from './services/guardrail-review.service';
import { MessageProcessingService } from './services/message-processing.service';

@Module({
  controllers: [MessageController],
  providers: [
    // repositories
    ChatMessageRepository,
    GuardrailReviewRepository,
    MessageProcessingRepository,
    // services
    ChatSessionService,
    GuardrailReviewService,
    MessageProcessingService,
  ],
  // GuardrailReviewService 导出给 agent runner（invokeReviewed 落审查档案）使用。
  exports: [ChatSessionService, MessageProcessingService, GuardrailReviewService],
})
export class BizMessageModule {}
