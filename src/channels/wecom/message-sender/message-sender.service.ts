import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@core/client-http';
import { ApiConfigService } from '@core/config';
import { SendMessageDto } from './dto/send-message.dto';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';

/**
 * 消息发送服务
 * 负责消息的发送（单发、群发）
 */
@Injectable()
export class MessageSenderService {
  private readonly logger = new Logger(MessageSenderService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 将企业级消息类型转换为小组级消息类型
   * @param enterpriseType 企业级消息类型
   * @returns 小组级消息类型
   */
  private convertToGroupMessageType(enterpriseType: number): number {
    // 企业级 → 小组级 映射表
    const typeMap: Record<number, number> = {
      7: 0, // TEXT → 文字消息
      6: 1, // IMAGE → 图片消息
      12: 2, // LINK → 网页链接
      1: 3, // FILE → 文件消息
      9: 4, // MINI_PROGRAM → 小程序消息
      13: 5, // VIDEO → 视频消息
      14: 7, // CHANNELS → 视频号消息
      2: 8, // VOICE → 语音消息
      5: 9, // EMOTION → 表情消息
      8: 10, // LOCATION → 位置消息
    };

    const groupType = typeMap[enterpriseType];
    if (groupType === undefined) {
      this.logger.warn(`未知的企业级消息类型: ${enterpriseType}，使用原始值，可能导致发送失败`);
      return enterpriseType;
    }

    return groupType;
  }

  /**
   * 发送消息
   * @param data - 发送消息数据
   * @returns 发送结果
   */
  async sendMessage(data: SendMessageDto | any) {
    try {
      // 提取字段
      const { _apiType, token, chatId, imBotId, imContactId, imRoomId, messageType, payload } =
        data;

      // 调试日志：查看 _apiType 的实际值
      this.logger.debug(`[API 路由] _apiType=${_apiType}, typeof=${typeof _apiType}`);

      let apiUrl: string;
      let requestBody: any;

      if (_apiType === 'group') {
        // 小组级 API：token 在请求体中
        // 生成唯一的 externalRequestId
        const externalRequestId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        // 转换消息类型：企业级 → 小组级
        const groupMessageType = this.convertToGroupMessageType(messageType);

        apiUrl = this.apiConfig.endpoints.message.sendGroup();
        requestBody = {
          token,
          chatId,
          externalRequestId,
          messageType: groupMessageType, // 使用转换后的类型
          payload,
        };
        this.logger.debug(`使用 API: 小组级 - ${apiUrl}`);
        this.logger.debug(`消息类型转换: 企业级(${messageType}) → 小组级(${groupMessageType})`);
        this.logger.debug(`请求体: ${JSON.stringify(requestBody)}`);
      } else {
        // 企业级 API：token 在 URL 参数中
        apiUrl = `${this.apiConfig.endpoints.message.send()}?token=${token}`;
        requestBody = {
          imBotId,
          imContactId,
          imRoomId,
          messageType,
          payload,
        };
        this.logger.debug(`使用 API: 企业级 - ${apiUrl}`);
      }

      const result = await this.httpService.post(apiUrl, requestBody);

      this.logger.log('发送消息成功');
      return result;
    } catch (error) {
      // 不在中间层打印日志，避免日志重复
      // 由顶层服务（MessageService）统一处理错误日志
      throw error;
    }
  }

  /**
   * 创建群发消息
   * @param data - 群发消息数据
   * @returns 群发结果
   */
  async createBroadcast(data: CreateBroadcastDto) {
    try {
      // 提取 token，作为 URL 参数传递
      const { token, ...requestBody } = data;
      const apiUrl = `${this.apiConfig.endpoints.message.send()}?token=${token}`;

      const result = await this.httpService.post(apiUrl, requestBody);

      this.logger.log('创建群发消息成功');
      return result;
    } catch (error) {
      // 不在中间层打印日志，避免日志重复
      // 由顶层服务统一处理错误日志
      throw error;
    }
  }
}
