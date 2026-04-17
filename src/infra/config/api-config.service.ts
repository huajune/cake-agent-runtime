import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * API 配置服务
 * 统一管理所有外部 API 的基地址和端点
 */
@Injectable()
export class ApiConfigService {
  // Stride API 基地址 - 小组级接口
  private readonly strideBaseUrl: string;
  // Stride API 基地址 - 企业级接口
  private readonly strideEnterpriseBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    // 从环境变量读取（已在启动时验证，这里可以安全使用）
    this.strideBaseUrl = this.configService.get<string>('STRIDE_API_BASE_URL')!;
    this.strideEnterpriseBaseUrl = this.configService.get<string>(
      'STRIDE_ENTERPRISE_API_BASE_URL',
    )!;
  }

  /**
   * 获取 Stride Stream API 基地址
   */
  getStrideStreamApiBaseUrl(): string {
    return `${this.strideBaseUrl}/stream-api`;
  }

  /**
   * 获取 Stride API v2 基地址（小组级）
   */
  getStrideApiV2BaseUrl(): string {
    return `${this.strideBaseUrl}/api/v2`;
  }

  /**
   * 获取 Stride API v2 基地址（企业级）
   */
  getStrideEnterpriseApiV2BaseUrl(): string {
    return `${this.strideEnterpriseBaseUrl}/api/v2`;
  }

  /**
   * 构建完整的 API URL
   * @param endpoint - API 端点（如 '/chat/list', '/message/send'）
   * @param version - API 版本（'stream-api' | 'v2' | 'enterprise-v2'）
   */
  buildApiUrl(
    endpoint: string,
    version: 'stream-api' | 'v2' | 'enterprise-v2' | 'enterprise-v1' = 'stream-api',
  ): string {
    let baseUrl: string;

    if (version === 'enterprise-v2') {
      baseUrl = this.getStrideEnterpriseApiV2BaseUrl();
    } else if (version === 'enterprise-v1') {
      baseUrl = `${this.strideEnterpriseBaseUrl}/api/v1`;
    } else if (version === 'v2') {
      baseUrl = this.getStrideApiV2BaseUrl();
    } else {
      baseUrl = this.getStrideStreamApiBaseUrl();
    }

    // 确保 endpoint 以 / 开头
    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${baseUrl}${normalizedEndpoint}`;
  }

  /**
   * Stream API 端点
   */
  readonly endpoints = {
    // 聊天相关
    chat: {
      list: () => this.buildApiUrl('/chat/list'),
      get: () => this.buildApiUrl('/chat/get'),
    },
    // 消息相关
    message: {
      history: () => this.buildApiUrl('/message/history'),
      send: () => this.buildApiUrl('/message/send', 'enterprise-v2'), // 企业级接口
      sendGroup: () => this.buildApiUrl('/message/send', 'stream-api'), // 小组级接口 (使用 stream-api)
      sentResult: () => this.buildApiUrl('/sentResult'),
    },
    // 联系人相关
    contact: {
      list: () => this.buildApiUrl('/contact/list'),
    },
    // 群聊相关
    room: {
      list: () => this.buildApiUrl('/room/list'),
      simpleList: () => this.buildApiUrl('/room/simpleList'),
      addMember: () => this.buildApiUrl('/room/addMember'),
      addFriendSend: () => this.buildApiUrl('/addFriend/room/send'), // 群聊加好友
    },
    // 群聊相关（企业级接口）
    groupChat: {
      list: () => this.buildApiUrl('/groupChat/list', 'enterprise-v2'), // 企业级群列表
      addMember: () => this.buildApiUrl('/instantReply/addFromRoom', 'enterprise-v1'), // 企业级拉人进群
    },
    // 用户相关
    user: {
      list: () => this.buildApiUrl('/user/list'),
    },
    // 机器人相关
    bot: {
      list: () => this.buildApiUrl('/bot/list'),
    },
    // 小组相关（使用企业级 API）
    group: {
      list: () => this.buildApiUrl('/group/list', 'enterprise-v2'),
    },
    // 客户相关（使用 v2 API）
    customer: {
      list: () => this.buildApiUrl('/customer/list', 'v2'),
      detail: () => this.buildApiUrl('/customer/detail', 'enterprise-v2'),
    },
  };
}
