import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';

// ==================== 错误类型 ====================

/**
 * 业务错误（后端返回 success: false）
 */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 网络/超时错误
 */
export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly cause?: AxiosError,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

// ==================== API 客户端 ====================

export const api = axios.create({
  baseURL: '/',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// -------------------- 请求拦截器 --------------------

const API_GUARD_TOKEN = import.meta.env.VITE_API_GUARD_TOKEN as string | undefined;

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (API_GUARD_TOKEN) {
    config.headers.Authorization = `Bearer ${API_GUARD_TOKEN}`;
  }
  return config;
});

// -------------------- 响应拦截器 --------------------

api.interceptors.response.use(
  (response) => {
    const body = response.data;

    // 非标准响应（如文件下载、第三方回调），直接透传
    if (!body || typeof body !== 'object' || !('success' in body)) {
      return response;
    }

    // 后端统一格式: { success: false, error: { code, message } }
    if (body.success === false) {
      const err = body.error || {};
      throw new ApiError(
        err.code || 'UNKNOWN_ERROR',
        err.message || '请求失败',
        err.details,
        response.status,
      );
    }

    // 成功时只保留 data 部分，省去每个 service 手动解包
    return { ...response, data: body.data !== undefined ? body.data : body };
  },
  (error: AxiosError) => {
    // 网络错误 / 超时
    if (!error.response) {
      const message = error.code === 'ECONNABORTED' ? '请求超时，请稍后重试' : '网络连接失败';
      throw new NetworkError(message, error);
    }

    // HTTP 错误但有后端错误体
    const body = error.response.data as Record<string, unknown> | undefined;
    if (body && typeof body === 'object' && 'error' in body) {
      const err = body.error as Record<string, unknown>;
      throw new ApiError(
        (err.code as string) || `HTTP_${error.response.status}`,
        (err.message as string) || '请求失败',
        err.details,
        error.response.status,
      );
    }

    // 无后端错误体的 HTTP 错误
    throw new ApiError(
      `HTTP_${error.response.status}`,
      error.message || '请求失败',
      undefined,
      error.response.status,
    );
  },
);

// ==================== 工具函数 ====================

/**
 * 解包响应数据（处理多层嵌套的 data 结构）
 *
 * 注意：拦截器已自动解包标准响应的第一层 data，
 * 此函数仅用于处理非标准或遗留接口的多层嵌套。
 */
export function unwrapResponse<T>(payload: unknown): T {
  let current = payload;
  while (current && typeof current === 'object' && 'data' in current) {
    current = (current as { data: unknown }).data;
  }
  return current as T;
}
