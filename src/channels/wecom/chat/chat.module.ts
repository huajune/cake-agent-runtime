import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
