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
  releasedAt: string;
}

export const MODEL_DICTIONARY: Record<string, ModelEntry> = {
  // ==================== Anthropic ====================
  'anthropic/claude-opus-4-8': {
    provider: 'anthropic',
    name: 'Claude Opus 4.8',
    description: 'Claude Opus 4.8 (旗舰推理 / 长程自治 Agent / 知识工作 / 多模态 / 长上下文)',
    releasedAt: '2026-05-28',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'anthropic/claude-opus-4-7': {
    provider: 'anthropic',
    name: 'Claude Opus 4.7',
    description: 'Claude Opus 4.7 (旗舰推理 / 全栈架构 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-04-16',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'anthropic/claude-sonnet-4-6': {
    provider: 'anthropic',
    name: 'Claude Sonnet 4.6',
    description:
      'Claude Sonnet 4.6 (综合推理 / Claude Code 默认首选 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-02-17',
    capabilities: ['tool-use', 'multimodal', 'thinking', 'long-context'],
  },
  'anthropic/claude-haiku-4-5': {
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    description: 'Claude Haiku 4.5 (极速响应 / 简单代码补全 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2025-10-15',
    capabilities: ['tool-use', 'multimodal', 'thinking', 'long-context'],
  },

  // ==================== OpenAI ====================
  'openai/gpt-5.5': {
    provider: 'openai',
    name: 'GPT-5.5',
    description: 'GPT-5.5 (旗舰推理 / 复杂专业工作 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-04-23',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.4-thinking': {
    provider: 'openai',
    name: 'GPT-5.4 Thinking',
    description:
      'GPT-5.4 Thinking (深度推理 / 工具调用 / 多模态 / 长上下文 / API 使用 gpt-5.4 + reasoning_effort)',
    releasedAt: '2026-03-05',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.4': {
    provider: 'openai',
    name: 'GPT-5.4',
    description: 'GPT-5.4 (通用旗舰 / 深度推理 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-03-05',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.4-mini': {
    provider: 'openai',
    name: 'GPT-5.4 Mini',
    description: 'GPT-5.4 Mini (高性价比 / 轻量任务 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-03-17',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },

  // ==================== Google ====================
  'google/gemini-3.1-pro': {
    provider: 'google',
    name: 'Gemini 3.1 Pro',
    description: 'Gemini 3.1 Pro (旗舰推理 / 2M 上下文 / 代码分析 / 工具调用 / 原生多模态)',
    releasedAt: '2026-02-19',
    capabilities: ['thinking', 'long-context', 'tool-use', 'multimodal'],
  },
  'google/gemini-3-flash': {
    provider: 'google',
    name: 'Gemini 3 Flash',
    description: 'Gemini 3 Flash (极速响应 / 工具调用 / 原生多模态 / 长上下文)',
    releasedAt: '2025-12-17',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'google/gemini-3.5-flash': {
    provider: 'google',
    name: 'Gemini 3.5 Flash',
    description: 'Gemini 3.5 Flash (新一代极速版 / 工具调用 / 原生多模态 / 长上下文)',
    releasedAt: '2026-05-19',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'google/gemini-3.1-flash-lite': {
    provider: 'google',
    name: 'Gemini 3.1 Flash-Lite',
    description: 'Gemini 3.1 Flash-Lite (低成本 / 轻量响应 / 工具调用 / 原生多模态 / 长上下文)',
    releasedAt: '2026-05-07',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },

  // ==================== DeepSeek ====================
  'deepseek/deepseek-v4-flash': {
    provider: 'deepseek',
    name: 'DeepSeek V4 Flash',
    description: 'DeepSeek V4 Flash (高速响应 / 高性价比 / Agent 能力 / 1M 上下文)',
    releasedAt: '2026-04-24',
    capabilities: ['thinking', 'tool-use', 'long-context'],
  },
  'deepseek/deepseek-v4-pro': {
    provider: 'deepseek',
    name: 'DeepSeek V4 Pro',
    description: 'DeepSeek V4 Pro (旗舰推理 / Agent 能力 / 工具调用 / 1M 上下文)',
    releasedAt: '2026-04-24',
    capabilities: ['thinking', 'tool-use', 'long-context'],
  },

  // ==================== 通义千问 (Qwen) ====================
  'qwen/qwen3.7-plus': {
    provider: 'qwen',
    name: 'Qwen3.7 Plus',
    description: 'Qwen3.7 Plus (增强推理 / 工具调用 / 图文多模态 / 长上下文)',
    releasedAt: '2026-06-02',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen3.6-max-preview': {
    provider: 'qwen',
    name: 'qwen3.6-max-preview',
    description: 'Qwen3.6 Max Preview (纯文本 / 深度思考 / 工具调用 / 256K 上下文)',
    releasedAt: '2026-04-20',
    capabilities: ['tool-use', 'thinking', 'long-context'],
  },
  'qwen/qwen3.6-plus': {
    provider: 'qwen',
    name: 'Qwen3.6 Plus',
    description: 'Qwen3.6 Plus (增强推理 / 原生思考模式 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-04-02',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen3-vl-plus': {
    provider: 'qwen',
    name: 'Qwen3 VL Plus',
    description: 'Qwen3 VL Plus (视觉理解 / 图片与文档 OCR / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-01-12',
    capabilities: ['multimodal', 'tool-use', 'thinking', 'long-context'],
  },

  // ==================== MoonshotAI / Kimi ====================
  // K2 系列（k2.5/k2.6/k2-thinking）已于 2026-07 移除：官方公告 K2 全平台 2026-08-31 下线，
  // kimi-thinking 系已停服；统一迁移到 K3。
  'moonshotai/kimi-k3': {
    provider: 'moonshotai',
    name: 'Kimi K3',
    description: 'Kimi K3 (2.8T MoE / 1M 上下文 / 原生多模态 / 默认开启思考)',
    releasedAt: '2026-07-16',
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
