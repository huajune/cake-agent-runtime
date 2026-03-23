import { Injectable, Logger } from '@nestjs/common';
import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  InternalAxiosRequestConfig,
  AxiosResponse,
} from 'axios';

/**
 * HTTP 客户端配置选项
 */
export interface HttpClientOptions {
  /** 基础 URL */
  baseURL?: string;
  /** 请求超时时间（毫秒） */
  timeout?: number;
  /** 默认请求头 */
  headers?: Record<string, string>;
  /** 日志前缀，用于区分不同的客户端 */
  logPrefix?: string;
  /** 是否启用详细日志 */
  verbose?: boolean;
}

/**
 * HTTP 客户端工厂
 * 用于创建配置化的 Axios 实例，统一管理拦截器和日志
 */
@Injectable()
export class HttpClientFactory {
  private readonly logger = new Logger(HttpClientFactory.name);

  /**
   * 创建 HTTP 客户端实例
   * @param options 配置选项
   * @returns 配置好的 Axios 实例
   */
  create(options: HttpClientOptions): AxiosInstance {
    const {
      baseURL,
      timeout = 30000,
      headers = {},
      logPrefix = '[HTTP]',
      verbose = false,
    } = options;

    this.logger.log(`创建 HTTP 客户端: ${logPrefix}`);
    if (baseURL) {
      this.logger.log(`  - Base URL: ${baseURL}`);
    }
    this.logger.log(`  - Timeout: ${timeout}ms`);

    // 创建 axios 实例
    const client = axios.create({
      baseURL,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    } as AxiosRequestConfig);

    // 添加请求拦截器
    client.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        const method = config.method?.toUpperCase() || 'UNKNOWN';
        const url = config.url || 'unknown';
        this.logger.log(`${logPrefix} 发送请求: ${method} ${url}`);

        if (verbose && config.data) {
          this.logger.debug(`${logPrefix} 请求体:`, config.data);
        }

        return config;
      },
      (error) => {
        this.logger.error(`${logPrefix} 请求错误:`, error);
        return Promise.reject(error);
      },
    );

    // 添加响应拦截器
    client.interceptors.response.use(
      (response: AxiosResponse) => {
        return response;
      },
      (error) => {
        if (error.response) {
          const status = error.response.status;
          const url = error.config?.url || 'unknown';
          // 只记录状态码和 URL，不打印完整响应体（可能包含大量数据）
          // 错误详情由调用方根据业务需要决定是否记录
          const errorMessage = error.response.data?.message || error.response.data?.error || '';
          this.logger.error(
            `${logPrefix} 响应错误 ${status}: ${url}${errorMessage ? ` - ${errorMessage}` : ''}`,
          );
        } else if (error.request) {
          this.logger.error(`${logPrefix} 无响应: ${error.message}`);
        } else {
          this.logger.error(`${logPrefix} 请求配置错误: ${error.message}`);
        }
        return Promise.reject(error);
      },
    );

    return client;
  }

  /**
   * 创建带 Bearer Token 认证的 HTTP 客户端
   * @param options 配置选项
   * @param token API Token
   * @returns 配置好的 Axios 实例
   */
  createWithBearerAuth(options: HttpClientOptions, token: string): AxiosInstance {
    return this.create({
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }
}
