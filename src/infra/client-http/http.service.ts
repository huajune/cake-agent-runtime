import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { HttpClientFactory } from './http-client.factory';

/**
 * HTTP 客户端服务
 * 提供通用的 HTTP 请求能力
 */
@Injectable()
export class HttpService {
  private readonly logger = new Logger(HttpService.name);
  private readonly httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpClientFactory: HttpClientFactory,
  ) {
    // 从环境变量读取配置，有默认值
    const timeout = this.configService.get<number>('HTTP_CLIENT_TIMEOUT') || 30000;

    this.logger.log(`初始化通用 HTTP 客户端，超时设置: ${timeout}ms`);

    // 使用工厂创建 HTTP 客户端实例
    // 注意：verbose 设为 false，避免打印包含敏感数据的请求体
    this.httpClient = this.httpClientFactory.create({
      timeout,
      logPrefix: '[HTTP Service]',
      verbose: false,
    });
  }

  /**
   * 调用第三方 API - GET 请求
   */
  async get(url: string, params?: any) {
    try {
      const response = await this.httpClient.get(url, { params });
      // 只记录响应成功，不打印完整数据（可能包含敏感/大量内容）
      this.logger.debug('GET 请求成功');
      return response.data;
    } catch (error) {
      // 不在底层打印日志，避免日志重复
      // 由调用方决定是否打印错误日志
      throw error;
    }
  }

  /**
   * 调用第三方 API - POST 请求
   */
  async post(url: string, data?: any) {
    try {
      const response = await this.httpClient.post(url, data);
      // 只记录响应成功，不打印完整数据（可能包含敏感/大量内容）
      this.logger.debug('POST 请求成功');
      return response.data;
    } catch (error) {
      // 不在底层打印日志，避免日志重复
      // 由调用方决定是否打印错误日志
      throw error;
    }
  }
}
