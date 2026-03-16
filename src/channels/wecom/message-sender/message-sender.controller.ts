import { Controller, Post, Body } from '@nestjs/common';
import { MessageSenderService } from './message-sender.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';

/**
 * 消息发送控制器
 * 提供消息发送接口（单发、群发）
 */
@Controller('message')
export class MessageSenderController {
  constructor(private readonly messageSenderService: MessageSenderService) {}

  /**
   * 发送消息
   * @description 向指定用户或群发送消息
   * @example POST /message/send
   */
  @Post('send')
  async sendMessage(@Body() body: SendMessageDto) {
    return await this.messageSenderService.sendMessage(body);
  }

  /**
   * 创建群发消息
   * @description 向多个用户批量发送消息
   * @example POST /message/broadcast
   */
  @Post('broadcast')
  async createBroadcast(@Body() body: CreateBroadcastDto) {
    return await this.messageSenderService.createBroadcast(body);
  }
}
