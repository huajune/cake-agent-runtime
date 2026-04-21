/**
 * 模型数据字典 — 所有已知模型的静态目录 (2026.04 更新版)
 *
 * RegistryService 根据已注册 Provider 过滤出当前可用模型。
 * 新增模型只需在对应 Provider 下加一行。
 */

/** 模型核心能力标签 */
export type ModelCapability = 'thinking' | 'tool-use' | 'multimodal' | 'long-context';

/** 模型元信息 */
export interface ModelEntry {
  provider: string;
  name: string;
  description: string;
  capabilities?: ModelCapability[];
}

export const MODEL_DICTIONARY: Record<string, ModelEntry> = {
  // ==================== Anthropic ====================
  'anthropic/claude-opus-4-7': {
    provider: 'anthropic',
    name: 'Claude Opus 4.7',
    description: 'Anthropic 旗舰模型 (原生支持全栈架构推理)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'anthropic/claude-sonnet-4-6': {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.6',
    description: 'Anthropic 综合最强 (Claude Code 默认首选)',
    capabilities: ['tool-use', 'multimodal', 'thinking'],
  },
  'anthropic/claude-haiku-4-5': {
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    description: 'Anthropic 极速模型 (适合简单代码补全)',
    capabilities: ['tool-use'],
  },

  // ==================== OpenAI ====================
  'openai/gpt-5.4-thinking': {
    provider: 'openai',
    name: 'GPT-5.4 Thinking',
    description: 'OpenAI 深度推理版 (解决 Hard 级 Bug/复杂逻辑调研)',
    capabilities: ['thinking', 'tool-use', 'long-context'],
  },
  'openai/gpt-5.4': {
    provider: 'openai',
    name: 'GPT-5.4',
    description: 'OpenAI 通用旗舰 (全能表现)',
    capabilities: ['tool-use', 'multimodal'],
  },
  'openai/gpt-5.3-chat-latest': {
    provider: 'openai',
    name: 'GPT-5.3 Chat (Latest)',
    description: 'OpenAI GPT-5.3 稳定快照',
    capabilities: ['tool-use'],
  },
  'openai/gpt-5.4-mini': {
    provider: 'openai',
    name: 'GPT-5.4 Mini',
    description: 'OpenAI 高性价比小模型',
    capabilities: ['tool-use'],
  },

  // ==================== Google ====================
  'google/gemini-3.1-pro': {
    provider: 'google',
    name: 'Gemini 3.1 Pro',
    description: 'Google 正式版 (2M 超长上下文 / 极强代码分析能力)',
    capabilities: ['long-context', 'tool-use', 'multimodal'],
  },
  'google/gemini-3-flash': {
    provider: 'google',
    name: 'Gemini 3 Flash',
    description: 'Google 多模态极速版',
    capabilities: ['tool-use', 'multimodal'],
  },
  'google/gemini-3.1-flash-lite': {
    provider: 'google',
    name: 'Gemini 3.1 Flash-Lite',
    description: 'Google 低成本轻量版',
    capabilities: ['tool-use'],
  },

  // ==================== DeepSeek ====================
  'deepseek/deepseek-chat': {
    provider: 'deepseek',
    name: 'DeepSeek Chat',
    description: 'DeepSeek V3.2 (通用对话 / 极致性价比)',
    capabilities: ['tool-use'],
  },

  // ==================== 通义千问 (Qwen) ====================
  'qwen/qwen3.6-max-preview': {
    provider: 'qwen',
    name: 'qwen3.6-max-preview',
    description: '通义千问 3.6 旗舰正式版',
    capabilities: ['tool-use', 'multimodal', 'thinking'],
  },
  'qwen/qwen3.6-plus': {
    provider: 'qwen',
    name: 'Qwen3.6 Plus',
    description: '通义千问 3.6 增强版 (原生支持思考模式)',
    capabilities: ['thinking', 'tool-use', 'multimodal'],
  },
  'qwen/qwen3-vl-plus': {
    provider: 'qwen',
    name: 'Qwen3 VL Plus',
    description: '通义千问视觉理解专用 (图片/文档/OCR 多模态)',
    capabilities: ['multimodal', 'tool-use'],
  },

  // ==================== MoonshotAI / Kimi ====================
  'moonshotai/kimi-k2.6': {
    provider: 'moonshotai',
    name: 'Kimi K2.6',
    description: 'Kimi K2.6 (Vibe Coding / Agent Swarm 协作) ¥6.5/27',
    capabilities: ['tool-use', 'long-context', 'thinking'],
  },
  'moonshotai/kimi-k2.5': {
    provider: 'moonshotai',
    name: 'Kimi K2.5',
    description: 'Kimi K2.5 (256K / 长文本处理专精) ¥4/21',
    capabilities: ['long-context', 'tool-use'],
  },
  'moonshotai/kimi-k2-thinking': {
    provider: 'moonshotai',
    name: 'Kimi K2 Thinking',
    description: 'Kimi K2 思考版 (深度逻辑推理 / 300+ 步工具调用)',
    capabilities: ['thinking', 'tool-use'],
  },
};

/** 模型 ID 类型 */
export type ModelId = keyof typeof MODEL_DICTIONARY;

/** * 按 Provider 过滤可用模型
 * 增加可选参数：必须包含的能力 (如 tool-use)
 */
export function getModelsByProvider(
  provider: string,
  requiredCapability?: ModelCapability,
): string[] {
  return Object.keys(MODEL_DICTIONARY).filter((id) => {
    const model = MODEL_DICTIONARY[id];
    const matchProvider = model.provider === provider;
    if (requiredCapability) {
      return matchProvider && model.capabilities?.includes(requiredCapability);
    }
    return matchProvider;
  });
}

/**
 * 根据 model id 解析模型能力，支持嵌套路由（如 openrouter/anthropic/claude-xxx）
 * 当模型未登记时返回 undefined，上层可据此决定是否保守降级。
 */
export function resolveModelCapabilities(modelId: string): ModelCapability[] | undefined {
  const direct = MODEL_DICTIONARY[modelId]?.capabilities;
  if (direct) return direct;

  const parts = modelId.split('/');
  for (let start = 1; start < parts.length - 1; start += 1) {
    const candidate = parts.slice(start).join('/');
    const entry = MODEL_DICTIONARY[candidate];
    if (entry?.capabilities) return entry.capabilities;
  }

  return undefined;
}

/** 判断模型是否具备指定能力（未登记时保守返回 false） */
export function modelHasCapability(modelId: string, capability: ModelCapability): boolean {
  return resolveModelCapabilities(modelId)?.includes(capability) ?? false;
}
