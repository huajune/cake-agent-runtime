import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * Token 缓存结构
 */
interface TokenCache {
  token: string;
  expireAt: number;
}

/**
 * 飞书 API 基础服务
 *
 * 职责：
 * - 统一管理 Tenant Access Token（带缓存）
 * - 提供带认证的 HTTP 请求方法
 * - 加载应用配置（appId/appSecret）
 *
 * 设计原则：
 * - 单一职责：只负责 Token 管理和 HTTP 请求
 * - 其他服务通过依赖注入使用，避免重复代码
 */
@Injectable()
export class FeishuApiService {
  private readonly logger = new Logger(FeishuApiService.name);
  private readonly apiBase = 'https://open.feishu.cn/open-apis';
  private readonly http: AxiosInstance;

  // Token 缓存
  private tokenCache?: TokenCache;

  // 应用配置
  private readonly appId: string;
  private readonly appSecret: string;

  constructor(private readonly configService: ConfigService) {
    // 优先使用代码配置，其次使用环境变量
    this.appId = this.loadAppId();
    this.appSecret = this.loadAppSecret();

    this.http = axios.create({
      baseURL: this.apiBase,
      timeout: 15000,
    });

    this.logger.log('FeishuApiService 初始化完成');
  }

  // ==================== Token 管理 ====================

  /**
   * 获取 Tenant Access Token（带缓存）
   * 提前 5 分钟刷新，避免请求时过期
   */
  async getToken(): Promise<string> {
    const now = Date.now();

    // 检查缓存是否有效
    if (this.tokenCache && this.tokenCache.expireAt > now + 5 * 60 * 1000) {
      return this.tokenCache.token;
    }

    // 请求新 Token
    const response = await this.http.post('/auth/v3/tenant_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret,
    });

    if (response.data.code !== 0) {
      const errorMsg = `获取飞书 Token 失败: ${response.data.msg}`;
      this.logger.error(errorMsg);
      throw new Error(errorMsg);
    }

    const token = response.data.tenant_access_token;
    const expireIn = response.data.expire || 7200;

    this.tokenCache = {
      token,
      expireAt: now + expireIn * 1000,
    };

    this.logger.log(`飞书 Token 已刷新，有效期 ${expireIn} 秒`);
    return token;
  }

  /**
   * 清除 Token 缓存（用于强制刷新）
   */
  clearTokenCache(): void {
    this.tokenCache = undefined;
    this.logger.log('Token 缓存已清除');
  }

  // ==================== HTTP 请求方法 ====================

  /**
   * 发送 GET 请求（自动带 Token）
   */
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const token = await this.getToken();
    return this.http.get<T>(url, {
      ...config,
      headers: {
        ...config?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }

  /**
   * 发送 POST 请求（自动带 Token）
   */
  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    const token = await this.getToken();
    return this.http.post<T>(url, data, {
      ...config,
      headers: {
        ...config?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }

  /**
   * 发送 PUT 请求（自动带 Token）
   */
  async put<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    const token = await this.getToken();
    return this.http.put<T>(url, data, {
      ...config,
      headers: {
        ...config?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }

  /**
   * 发送 DELETE 请求（自动带 Token）
   */
  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const token = await this.getToken();
    return this.http.delete<T>(url, {
      ...config,
      headers: {
        ...config?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }

  // ==================== 配置加载 ====================

  /**
   * 获取应用 ID
   */
  getAppId(): string {
    return this.appId;
  }

  /**
   * 获取应用密钥
   */
  getAppSecret(): string {
    return this.appSecret;
  }

  private loadAppId(): string {
    return this.configService.get<string>('FEISHU_APP_ID') || '';
  }

  private loadAppSecret(): string {
    return this.configService.get<string>('FEISHU_APP_SECRET') || '';
  }
}
