/**
 * 模型数据字典 — 所有已知模型的静态目录
 *
 * RegistryService 根据已注册 Provider 过滤出当前可用模型。
 *
 * 新增模型只需在对应 Provider 下加一行。
 */

/** 模型元信息 */
export interface ModelEntry {
  provider: string;
  name: string;
  description: string;
}

export const MODEL_DICTIONARY: Record<string, ModelEntry> = {
  // ==================== Anthropic ====================
  'anthropic/claude-sonnet-4-6': {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.6',
    description: 'Anthropic Claude Sonnet 4.6 (最新)',
  },
  'anthropic/claude-sonnet-4-5-20250929': {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.5',
    description: 'Anthropic Claude Sonnet 4.5',
  },
  'anthropic/claude-haiku-4-5': {
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    description: 'Anthropic Claude Haiku 4.5 (快速)',
  },

  // ==================== OpenAI (via 代理) ====================
  'openai/gpt-5.1': {
    provider: 'openai',
    name: 'GPT-5.1',
    description: 'OpenAI GPT-5.1',
  },
  'openai/gpt-5-chat-latest': {
    provider: 'openai',
    name: 'GPT-5 Chat (最新)',
    description: 'OpenAI GPT-5 Chat',
  },
  'openai/gpt-5-mini': {
    provider: 'openai',
    name: 'GPT-5 Mini',
    description: 'OpenAI GPT-5 Mini',
  },
  'openai/gpt-4o': {
    provider: 'openai',
    name: 'GPT-4o',
    description: 'OpenAI GPT-4o',
  },

  // ==================== Google ====================
  'google/gemini-3-pro-preview': {
    provider: 'google',
    name: 'Gemini 3 Pro Preview',
    description: 'Google Gemini 3 Pro 预览版',
  },
  'google/gemini-2.5-pro-preview-05-06': {
    provider: 'google',
    name: 'Gemini 2.5 Pro Preview',
    description: 'Google Gemini 2.5 Pro',
  },
  'google/gemini-2.5-flash-preview-04-17': {
    provider: 'google',
    name: 'Gemini 2.5 Flash Preview',
    description: 'Google Gemini 2.5 Flash (快速)',
  },

  // ==================== DeepSeek ====================
  'deepseek/deepseek-chat': {
    provider: 'deepseek',
    name: 'DeepSeek Chat',
    description: 'DeepSeek V3',
  },

  // ==================== 通义千问 (Qwen) ====================
  'qwen/qwen-max-latest': {
    provider: 'qwen',
    name: 'Qwen Max Latest',
    description: '通义千问旗舰版',
  },
  'qwen/qwen-plus-latest': {
    provider: 'qwen',
    name: 'Qwen Plus Latest',
    description: '通义千问增强版',
  },

  // ==================== MoonshotAI / Kimi ====================
  'moonshotai/kimi-k2-0905-preview': {
    provider: 'moonshotai',
    name: 'Kimi K2 0905 Preview',
    description: 'Kimi K2 0905 预览版',
  },
  'moonshotai/kimi-k2-thinking-turbo': {
    provider: 'moonshotai',
    name: 'Kimi K2 Thinking Turbo',
    description: 'Kimi K2 思考加速版',
  },

  // ==================== OpenRouter ====================
  'openrouter/qwen/qwen3-235b-a22b': {
    provider: 'openrouter',
    name: 'Qwen3 235B (OpenRouter)',
    description: '通过 OpenRouter 访问 Qwen3 235B',
  },
  'openrouter/qwen/qwen-max': {
    provider: 'openrouter',
    name: 'Qwen Max (OpenRouter)',
    description: '通过 OpenRouter 访问 Qwen Max',
  },
  'openrouter/moonshotai/kimi-k2-0905': {
    provider: 'openrouter',
    name: 'Kimi K2 0905 (OpenRouter)',
    description: '通过 OpenRouter 访问 Kimi K2',
  },
  'openrouter/anthropic/claude-3.7-sonnet': {
    provider: 'openrouter',
    name: 'Claude 3.7 Sonnet (OpenRouter)',
    description: '通过 OpenRouter 访问 Claude 3.7 Sonnet',
  },
  'openrouter/anthropic/claude-sonnet-4': {
    provider: 'openrouter',
    name: 'Claude Sonnet 4 (OpenRouter)',
    description: '通过 OpenRouter 访问 Claude Sonnet 4',
  },
  'openrouter/openai/gpt-4.1': {
    provider: 'openrouter',
    name: 'GPT-4.1 (OpenRouter)',
    description: '通过 OpenRouter 访问 GPT-4.1',
  },
  'openrouter/openai/gpt-4o': {
    provider: 'openrouter',
    name: 'GPT-4o (OpenRouter)',
    description: '通过 OpenRouter 访问 GPT-4o',
  },

  // ==================== OhMyGPT (代理) ====================
  'ohmygpt/gemini-2.5-pro-preview-06-05': {
    provider: 'ohmygpt',
    name: 'Gemini 2.5 Pro Preview (OhMyGPT)',
    description: '通过 OhMyGPT 访问 Gemini 2.5 Pro',
  },
  'ohmygpt/gemini-2.5-flash-preview-05-20': {
    provider: 'ohmygpt',
    name: 'Gemini 2.5 Flash Preview (OhMyGPT)',
    description: '通过 OhMyGPT 访问 Gemini 2.5 Flash',
  },
};

/** 模型 ID 类型 */
export type ModelId = keyof typeof MODEL_DICTIONARY;

/** 按 Provider 过滤可用模型 */
export function getModelsByProvider(provider: string): string[] {
  return Object.keys(MODEL_DICTIONARY).filter((id) => MODEL_DICTIONARY[id].provider === provider);
}
