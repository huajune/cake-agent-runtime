import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@infra/client-http/http.service';
import { ApiConfigService } from '@infra/config/api-config.service';

/**
 * 群聊管理服务
 * 负责群聊列表查询、群成员管理、群聊加好友等功能
 */
@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly apiConfig: ApiConfigService,
  ) {}

  /**
   * 获取群列表（简单版，不包含成员信息）
   * @param token - 小组级 token
   * @param current - 当前页码
   * @param pageSize - 每页大小
   * @param wxid - 微信 ID（可选，用于精确查询）
   * @returns 群列表数据
   */
  async getRoomSimpleList(token: string, current: number, pageSize: number, wxid?: string) {
    try {
      const apiUrl = this.apiConfig.endpoints.room.simpleList();

      const params: any = {
        token,
        current,
        pageSize,
      };

      if (wxid) {
        params.wxid = wxid;
      }

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取群列表（简单版）成功');
      return result;
    } catch (error) {
      this.logger.error('获取群列表（简单版）失败:', error);
      throw error;
    }
  }

  /**
   * 获取群列表（完整版，包含成员信息）
   * @param token - 小组级 token
   * @param current - 当前页码
   * @param pageSize - 每页大小
   * @param wxid - 微信 ID（可选，用于精确查询）
   * @returns 群列表数据（含成员）
   */
  async getRoomList(token: string, current: number, pageSize: number, wxid?: string) {
    try {
      const apiUrl = this.apiConfig.endpoints.room.list();

      const params: any = { token };

      if (wxid) {
        params.wxid = wxid;
      } else {
        params.current = current;
        params.pageSize = pageSize;
      }

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取群列表（含成员信息）成功');
      return result;
    } catch (error) {
      this.logger.error('获取群列表（含成员信息）失败:', error);
      throw error;
    }
  }

  /**
   * 获取企业级群列表
   * @param token - 企业级 token
   * @param current - 当前页码（最小值 1）
   * @param pageSize - 每页大小（最大 1000，默认 10）
   * @param imBotId - 托管账号系统 ID（可选）
   * @param wecomUserId - 员工 IM ID（可选）
   * @returns 企业级群列表数据
   */
  async getEnterpriseGroupChatList(
    token: string,
    current?: number,
    pageSize?: number,
    imBotId?: string,
    wecomUserId?: string,
  ) {
    try {
      const apiUrl = this.apiConfig.endpoints.groupChat.list();

      const params: any = { token };

      if (current !== undefined) {
        params.current = current;
      }
      if (pageSize !== undefined) {
        params.pageSize = pageSize;
      }
      if (imBotId) {
        params.imBotId = imBotId;
      }
      if (wecomUserId) {
        params.wecomUserId = wecomUserId;
      }

      const result = await this.httpService.get(apiUrl, params);

      this.logger.log('获取企业级群列表成功');
      return result;
    } catch (error) {
      this.logger.error('获取企业级群列表失败:', error);
      throw error;
    }
  }

  /**
   * 加入群聊
   * @param data - 加入群聊参数
   * @returns 加入结果
   */
  async addMember(data: {
    token: string;
    botUserId: string;
    contactWxid: string;
    roomWxid: string;
  }) {
    try {
      const apiUrl = this.apiConfig.endpoints.room.addMember();
      const result = await this.httpService.post(apiUrl, data);
      this.logger.log('加入群聊请求成功');
      return result;
    } catch (error) {
      this.logger.error('加入群聊请求失败:', error);
      throw error;
    }
  }

  /**
   * 群聊加好友
   * @param data - 加好友参数
   * @returns 加好友结果
   */
  async addFriendFromRoom(data: {
    token: string;
    roomId: string;
    contactId: string;
    remark?: string;
    helloMsg: string;
    extraInfo?: string;
    userId: string;
  }) {
    try {
      const apiUrl = this.apiConfig.endpoints.room.addFriendSend();
      const result = await this.httpService.post(apiUrl, data);
      this.logger.log('群聊加好友请求成功');
      return result;
    } catch (error) {
      this.logger.error('群聊加好友请求失败:', error);
      throw error;
    }
  }

  /**
   * 处理加入群聊事件回调
   * @param data - 回调数据
   * @returns 处理结果
   */
  async handleJoinedCallback(data: any) {
    try {
      this.logger.log('收到加入群聊事件回调');
      this.logger.log('Object:', data);
      // 这里可以添加业务逻辑，比如保存到数据库、触发其他操作等
      return { success: true, message: '加入群聊回调处理成功' };
    } catch (error) {
      this.logger.error('处理加入群聊回调失败:', error);
      throw error;
    }
  }

  /**
   * 处理退出群聊事件回调
   * @param data - 回调数据
   * @returns 处理结果
   */
  async handleLeftCallback(data: any) {
    try {
      this.logger.log('收到退出群聊事件回调');
      this.logger.log('Object:', data);
      // 这里可以添加业务逻辑，比如清理群聊缓存、更新数据库等
      return { success: true, message: '退出群聊回调处理成功' };
    } catch (error) {
      this.logger.error('处理退出群聊回调失败:', error);
      throw error;
    }
  }
}
