import { Controller, Get, Query } from '@nestjs/common';
import { ChatService } from './chat.service';

/**
 * 会话管理控制器
 * 提供会话列表和聊天历史查询接口
 */
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * 获取会话列表
   * @description 获取当前机器人的所有会话列表，支持分页
   * @example GET /chat/list?token=xxx&pageSize=10
   */
  @Get('list')
  async getChatList(
    @Query('token') token: string,
    @Query('iterator') iterator?: string,
    @Query('pageSize') pageSize?: number,
  ) {
    return await this.chatService.getChatList(token, iterator, pageSize);
  }

  /**
   * 获取聊天历史
   * @description 获取指定日期的聊天历史记录
   * @example GET /chat/history?token=xxx&pageSize=5&snapshotDay=2025-10-10
   */
  @Get('history')
  async getMessageHistory(
    @Query('token') token: string,
    @Query('pageSize') pageSize: number,
    @Query('snapshotDay') snapshotDay: string,
    @Query('seq') seq?: string,
  ) {
    return await this.chatService.getMessageHistory(token, pageSize, snapshotDay, seq);
  }

  /**
   * 获取指定会话
   * @description 获取指定chatId的会话信息。此接口适合在接收到某一个会话事件推送之后，当通过事件中的chatId找不到对应的会话信息时调用
   * @note 有频率限制：300次/30秒
   * @example GET /chat/get?token=xxx&chatId=6810462536****23b2fe4f1b
   */
  @Get('get')
  async getChatById(@Query('token') token: string, @Query('chatId') chatId: string) {
    return await this.chatService.getChatById(token, chatId);
  }
}
