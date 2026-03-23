import { Controller, Get, Query } from '@nestjs/common';
import { BotService } from './bot.service';

@Controller('bot')
export class BotController {
  constructor(private readonly botService: BotService) {}

  /**
   * 获取托管账号列表
   * 访问: GET http://localhost:3000/bot/list
   */
  @Get('list')
  async getBotList(@Query('token') token: string) {
    return await this.botService.getBotList(token);
  }
}
