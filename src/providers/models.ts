/**
 * 模型数据字典 — 所有已知模型的静态目录 (2026.07 更新版)
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
  'anthropic/claude-opus-4-8': {
    provider: 'anthropic',
    name: 'Claude Opus 4.8',
    description: 'Anthropic 旗舰模型 (长程自治 Agent / 知识工作 SOTA)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
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
    capabilities: ['tool-use', 'multimodal', 'thinking', 'long-context'],
  },
  'anthropic/claude-haiku-4-5': {
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    description: 'Anthropic 极速模型 (适合简单代码补全)',
    capabilities: ['tool-use', 'multimodal', 'thinking', 'long-context'],
  },

  // ==================== OpenAI ====================
  'openai/gpt-5.5': {
    provider: 'openai',
    name: 'GPT-5.5',
    description: 'OpenAI 最新旗舰 (复杂专业工作)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.4-thinking': {
    provider: 'openai',
    name: 'GPT-5.4 Thinking',
    description: 'OpenAI 深度推理版 (ChatGPT 命名；API 通常使用 gpt-5.4 + reasoning_effort)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.4': {
    provider: 'openai',
    name: 'GPT-5.4',
    description: 'OpenAI 通用旗舰 (全能表现)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.3-chat-latest': {
    provider: 'openai',
    name: 'GPT-5.3 Chat (Latest)',
    description: 'OpenAI GPT-5.3 Chat 快照（旧版快照；优先迁移到最新 GPT-5.x）',
    capabilities: ['tool-use', 'multimodal'],
  },
  'openai/gpt-5.4-mini': {
    provider: 'openai',
    name: 'GPT-5.4 Mini',
    description: 'OpenAI 高性价比小模型',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },

  // ==================== Google ====================
  'google/gemini-3.1-pro': {
    provider: 'google',
    name: 'Gemini 3.1 Pro',
    description: 'Google 正式版 (2M 超长上下文 / 极强代码分析能力)',
    capabilities: ['thinking', 'long-context', 'tool-use', 'multimodal'],
  },
  'google/gemini-3-flash': {
    provider: 'google',
    name: 'Gemini 3 Flash',
    description: 'Google 多模态极速版',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'google/gemini-3.5-flash': {
    provider: 'google',
    name: 'Gemini 3.5 Flash',
    description: 'Google 新一代极速版 (2026-05 I/O 发布)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'google/gemini-3.1-flash-lite': {
    provider: 'google',
    name: 'Gemini 3.1 Flash-Lite',
    description: 'Google 低成本轻量版',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },

  // ==================== DeepSeek ====================
  'deepseek/deepseek-v4-flash': {
    provider: 'deepseek',
    name: 'DeepSeek V4 Flash',
    description: 'DeepSeek V4 Flash (高速 / 高性价比 / 1M 上下文)',
    capabilities: ['thinking', 'tool-use', 'long-context'],
  },
  'deepseek/deepseek-v4-pro': {
    provider: 'deepseek',
    name: 'DeepSeek V4 Pro',
    description: 'DeepSeek V4 Pro (旗舰推理 / Agent 能力 / 1M 上下文)',
    capabilities: ['thinking', 'tool-use', 'long-context'],
  },

  // ==================== 通义千问 (Qwen) ====================
  'qwen/qwen3.7-plus': {
    provider: 'qwen',
    name: 'Qwen3.7 Plus',
    description: '通义千问 3.7 增强版 (思考 / 工具调用 / 图文多模态)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen3.6-max-preview': {
    provider: 'qwen',
    name: 'qwen3.6-max-preview',
    description: '通义千问 3.6 Max Preview（纯文本 / 思考 / 工具调用 / 256K 上下文）',
    capabilities: ['tool-use', 'thinking', 'long-context'],
  },
  'qwen/qwen3.6-plus': {
    provider: 'qwen',
    name: 'Qwen3.6 Plus',
    description: '通义千问 3.6 增强版 (原生支持思考模式)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen3-vl-plus': {
    provider: 'qwen',
    name: 'Qwen3 VL Plus',
    description: '通义千问视觉理解专用 (图片/文档/OCR 多模态)',
    capabilities: ['multimodal', 'tool-use', 'thinking', 'long-context'],
  },

  // ==================== MoonshotAI / Kimi ====================
  // K2 系列（k2.5/k2.6/k2-thinking）已于 2026-07 移除：官方公告 K2 全平台 2026-08-31 下线，
  // kimi-thinking 系已停服；统一迁移到 K3。
  'moonshotai/kimi-k3': {
    provider: 'moonshotai',
    name: 'Kimi K3',
    description: 'Kimi K3 (2.8T MoE / 1M 上下文 / 原生多模态 / 默认开启思考，2026-07-16 发布)',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
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
