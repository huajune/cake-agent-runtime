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

  // ==================== Google ====================
  'google/gemini-3-pro-preview': {
    provider: 'google',
    name: 'Gemini 3 Pro Preview',
    description: 'Google Gemini 3 Pro 预览版',
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
  'qwen/qwen3.6-plus': {
    provider: 'qwen',
    name: 'Qwen3.6 Plus',
    description: '通义千问3.6增强版（支持文本/图像/视频，支持思考模式）',
  },

  // ==================== MoonshotAI / Kimi ====================
  'moonshotai/kimi-k2-thinking-turbo': {
    provider: 'moonshotai',
    name: 'Kimi K2 Thinking Turbo',
    description: 'Kimi K2 思考加速版',
  },
};

/** 模型 ID 类型 */
export type ModelId = keyof typeof MODEL_DICTIONARY;

/** 按 Provider 过滤可用模型 */
export function getModelsByProvider(provider: string): string[] {
  return Object.keys(MODEL_DICTIONARY).filter((id) => MODEL_DICTIONARY[id].provider === provider);
}
