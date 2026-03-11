import { Module } from '@nestjs/common';
import { MessageChatController } from './message-chat.controller';
import { MessageRecordsController } from './message-records.controller';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [AnalyticsModule],
  controllers: [MessageChatController, MessageRecordsController],
})
export class BizMessageModule {}
