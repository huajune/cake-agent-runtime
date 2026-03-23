/**
 * Provider 配置类型与默认值
 *
 * 每个 Provider 通过环境变量 API Key 按需注册。
 * OpenAI-compatible 厂商使用 @ai-sdk/openai-compatible 接入。
 */

// ==================== 模型角色 ====================

/**
 * 模型角色定义 — 单一来源
 *
 * 每个角色对应环境变量 AGENT_{ROLE}_MODEL 和 AGENT_{ROLE}_FALLBACKS。
 * 新增角色只需在此处添加一行。
 */
export enum ModelRole {
  Chat = 'chat',
  Extract = 'extract',
  Vision = 'vision',
  Evaluate = 'evaluate',
}

// ==================== Provider 配置 ====================

/** 单个 Provider 的静态配置 */
export interface ProviderDefaultConfig {
  /** 环境变量名（API Key） */
  envKey: string;
  /** 环境变量名（baseURL 覆盖，可选） */
  baseUrlEnvKey?: string;
  /** 默认 baseURL */
  defaultBaseURL: string;
  /** 显示名称 */
  displayName: string;
}

/** 错误分类（对标 ZeroClaw reliable.rs） */
export type ErrorCategory = 'retryable' | 'non_retryable' | 'rate_limited';

/** 容错配置 */
export interface ReliableConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 基础退避时间 (ms) */
  baseBackoffMs: number;
  /** 最大退避时间 (ms) */
  maxBackoffMs: number;
}

export const DEFAULT_RELIABLE_CONFIG: ReliableConfig = {
  maxRetries: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 10_000,
};

/**
 * OpenAI-compatible Provider 默认配置表
 *
 * 原生 AI SDK Provider（anthropic, google, deepseek）不在此表中，
 * 它们使用各自专用 SDK，在 RegistryService 中单独注册。
 *
 * deepseek 同时出现在此表（兼容模式备用）和原生注册中，
 * RegistryService 优先使用原生 SDK，此处会被跳过。
 *
 * openai / ohmygpt 通过代理服务访问，共享 ANTHROPIC_API_KEY。
 */
// ==================== Vision 能力检测 ====================

/** 已知支持多模态 vision 的厂商关键词（匹配模型 ID 中任意位置） */
const VISION_CAPABLE_KEYWORDS = ['anthropic/', 'openai/', 'google/', 'gemini'];

/** 已知不支持 vision 的厂商关键词 */
const VISION_INCAPABLE_KEYWORDS = ['deepseek/', 'moonshotai/', 'qwen/'];

/**
 * 检测模型是否支持多模态 vision（图片输入）
 * 支持嵌套路由格式如 openrouter/anthropic/claude-sonnet-4、ohmygpt/gemini-2.5-pro
 * 不支持时应降级为纯文字描述
 */
export function supportsVision(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // 先排除已知不支持的
  if (VISION_INCAPABLE_KEYWORDS.some((k) => id.includes(k))) return false;
  // 再匹配已知支持的
  return VISION_CAPABLE_KEYWORDS.some((k) => id.includes(k));
}

// ==================== Provider 默认配置 ====================

export const PROVIDER_DEFAULTS: Record<string, ProviderDefaultConfig> = {
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    baseUrlEnvKey: 'DEEPSEEK_BASE_URL',
    defaultBaseURL: 'https://api.deepseek.com',
    displayName: 'DeepSeek',
  },
  qwen: {
    envKey: 'DASHSCOPE_API_KEY',
    baseUrlEnvKey: 'QWEN_BASE_URL',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    displayName: '通义千问 (DashScope)',
  },
  moonshotai: {
    envKey: 'MOONSHOT_API_KEY',
    baseUrlEnvKey: 'MOONSHOT_BASE_URL',
    defaultBaseURL: 'https://api.moonshot.cn/v1',
    displayName: 'MoonshotAI / Kimi',
  },
  ohmygpt: {
    envKey: 'ANTHROPIC_API_KEY',
    baseUrlEnvKey: 'OHMYGPT_BASE_URL',
    defaultBaseURL: 'https://c-z0-api-01.hash070.com/v1',
    displayName: 'OhMyGPT (代理)',
  },
};
