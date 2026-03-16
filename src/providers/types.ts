/**
 * Provider 配置类型与默认值
 *
 * 每个 Provider 通过环境变量 API Key 按需注册。
 * OpenAI-compatible 厂商使用 @ai-sdk/openai-compatible 接入。
 */

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
 * 原生 AI SDK Provider（anthropic, openai, google）不在此表中，
 * 它们使用各自专用 SDK，在 RegistryService 中单独注册。
 */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaultConfig> = {
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    baseUrlEnvKey: 'DEEPSEEK_BASE_URL',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    displayName: 'DeepSeek',
  },
  qwen: {
    envKey: 'QWEN_API_KEY',
    baseUrlEnvKey: 'QWEN_BASE_URL',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    displayName: '通义千问 (DashScope)',
  },
  zhipu: {
    envKey: 'ZHIPU_API_KEY',
    baseUrlEnvKey: 'ZHIPU_BASE_URL',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    displayName: '智谱 GLM',
  },
  moonshot: {
    envKey: 'MOONSHOT_API_KEY',
    baseUrlEnvKey: 'MOONSHOT_BASE_URL',
    defaultBaseURL: 'https://api.moonshot.cn/v1',
    displayName: 'Moonshot / Kimi',
  },
  doubao: {
    envKey: 'DOUBAO_API_KEY',
    baseUrlEnvKey: 'DOUBAO_BASE_URL',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    displayName: '字节豆包',
  },
  minimax: {
    envKey: 'MINIMAX_API_KEY',
    baseUrlEnvKey: 'MINIMAX_BASE_URL',
    defaultBaseURL: 'https://api.minimax.chat/v1',
    displayName: 'MiniMax',
  },
  yi: {
    envKey: 'YI_API_KEY',
    baseUrlEnvKey: 'YI_BASE_URL',
    defaultBaseURL: 'https://api.lingyiwanwu.com/v1',
    displayName: '零一万物 (Yi)',
  },
  stepfun: {
    envKey: 'STEPFUN_API_KEY',
    baseUrlEnvKey: 'STEPFUN_BASE_URL',
    defaultBaseURL: 'https://api.stepfun.com/v1',
    displayName: '阶跃星辰',
  },
  siliconflow: {
    envKey: 'SILICONFLOW_API_KEY',
    baseUrlEnvKey: 'SILICONFLOW_BASE_URL',
    defaultBaseURL: 'https://api.siliconflow.cn/v1',
    displayName: '硅基流动 (SiliconFlow)',
  },
  groq: {
    envKey: 'GROQ_API_KEY',
    baseUrlEnvKey: 'GROQ_BASE_URL',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    displayName: 'Groq',
  },
  openrouter: {
    envKey: 'OPENROUTER_API_KEY',
    baseUrlEnvKey: 'OPENROUTER_BASE_URL',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    displayName: 'OpenRouter',
  },
};
