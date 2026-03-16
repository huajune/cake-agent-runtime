import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';

/**
 * 会话管理服务
 * 负责管理聊天会话列表和消息历史
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 获取会话列表
   * @param token - 小组级 token
   * @param iterator - 分页游标（可选）
   * @param pageSize - 每页大小（可选）
   * @returns 会话列表数据
   * @throws HttpException 当 API 调用失败时
   */
  async getChatList(token: string, iterator?: string, pageSize?: number) {
    try {
      const apiUrl = this.apiConfig.endpoints.chat.list();
      const params: any = { token };

      if (iterator) {
        params.iterator = iterator;
      }

      if (pageSize !== undefined) {
        params.pageSize = pageSize;
      }

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取会话列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取会话列表失败:', error);
      throw error;
    }
  }

  /**
   * 获取聊天历史
   * @param token - 小组级 token
   * @param pageSize - 每页大小
   * @param snapshotDay - 快照日期（格式：YYYY-MM-DD）
   * @param seq - 分页序列号（可选）
   * @returns 聊天历史数据
   * @throws HttpException 当 API 调用失败时
   */
  async getMessageHistory(token: string, pageSize: number, snapshotDay: string, seq?: string) {
    try {
      const apiUrl = this.apiConfig.endpoints.message.history();

      const params: any = {
        token,
        pageSize,
        snapshotDay,
      };

      if (seq) {
        params.seq = seq;
      }

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取聊天历史成功');
      return result;
    } catch (error) {
      this.logger.error('获取聊天历史失败:', error);
      throw error;
    }
  }

  /**
   * 获取指定会话信息
   * @param token - 小组级调用接口凭证
   * @param chatId - 希望获取数据的对话id
   * @returns 会话详细信息
   * @throws HttpException 当 API 调用失败时
   * @description 此接口适合在接收到某一个会话事件推送之后，当通过事件中的chatId找不到对应的会话信息时，调用此接口获取会话信息
   * @note 因为这个事件大多数情况是建议在通过事件进行触发，因此这个接口有频率调用限制，当前限制为300次/30秒
   */
  async getChatById(token: string, chatId: string) {
    try {
      const apiUrl = this.apiConfig.endpoints.chat.get();

      const params = {
        token,
        chatId,
      };

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log(`获取会话信息成功: chatId=${chatId}`);
      return result;
    } catch (error) {
      this.logger.error(`获取会话信息失败: chatId=${chatId}`, error);
      throw error;
    }
  }
}
