import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { HttpModule } from '@infra/client-http/http.module';
import { ApiConfigModule } from '@infra/config/api-config.module';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [BotController],
  providers: [BotService],
})
export class BotModule {}
