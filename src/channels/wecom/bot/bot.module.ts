import { Module } from '@nestjs/common';
import { BotController } from './bot.controller';
import { BotService } from './bot.service';
import { HttpModule } from '@core/client-http';
import { ApiConfigModule } from '@core/config';

@Module({
  imports: [HttpModule, ApiConfigModule],
  controllers: [BotController],
  providers: [BotService],
})
export class BotModule {}
