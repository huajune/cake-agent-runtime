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
  // 收录原则（2026-07-28 产品裁定）：每家厂商只保留各档位的**最新**在售模型，
  // 上一代模型即使官方仍 Active 也不收录；新一代发布后应同步替换对应档位。
  // ⚠️ 本字典是 supportsVision 的单一事实源、Dashboard 模型覆盖保存校验的白名单；
  // 运行时 resolve() 不查本字典，历史配置里的旧 ID 仍可执行（但图片轮会走 fallback）。
  // ==================== Anthropic ====================
  'anthropic/claude-opus-5': {
    provider: 'anthropic',
    name: 'Claude Opus 5',
    description: 'Claude Opus 5 (旗舰推理 / 1M 上下文 / 自适应思考+五档 effort / 多模态)',
    releasedAt: '2026-07-24',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'anthropic/claude-sonnet-5': {
    provider: 'anthropic',
    name: 'Claude Sonnet 5',
    description:
      'Claude Sonnet 5 (Agent 编码/工具调用主力 / 近 Opus 性能低价位 / 多模态 / 长上下文)',
    releasedAt: '2026-06-30',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'anthropic/claude-haiku-4-5': {
    provider: 'anthropic',
    name: 'Claude Haiku 4.5',
    description: 'Claude Haiku 4.5 (极速响应 / 简单代码补全 / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2025-10-15',
    capabilities: ['tool-use', 'multimodal', 'thinking', 'long-context'],
  },

  // ==================== OpenAI ====================
  'openai/gpt-5.6-sol': {
    provider: 'openai',
    name: 'GPT-5.6 Sol',
    description: 'GPT-5.6 Sol (旗舰档 / 最难任务 / 1.05M 上下文 / 工具调用 / 多模态)',
    releasedAt: '2026-07-09',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.6-terra': {
    provider: 'openai',
    name: 'GPT-5.6 Terra',
    description: 'GPT-5.6 Terra (均衡档 / 日常工作 / 1.05M 上下文 / 工具调用 / 多模态)',
    releasedAt: '2026-07-09',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'openai/gpt-5.6-luna': {
    provider: 'openai',
    name: 'GPT-5.6 Luna',
    description: 'GPT-5.6 Luna (高速低成本档 / 1.05M 上下文 / 工具调用 / 多模态)',
    releasedAt: '2026-07-09',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  // ==================== Google ====================
  // 2026-07-28 实测 v1beta/models 校正：3.1 Pro 官方只有 -preview 后缀 ID（裸
  // gemini-3.1-pro 打过去 404）；gemini-3-flash 同理只有 preview 且已被
  // 3.5/3.6 Flash 取代，直接移除。
  'google/gemini-3.1-pro-preview': {
    provider: 'google',
    name: 'Gemini 3.1 Pro (Preview)',
    description: 'Gemini 3.1 Pro Preview (旗舰推理 / 2M 上下文 / 代码分析 / 工具调用 / 原生多模态)',
    releasedAt: '2026-02-19',
    capabilities: ['thinking', 'long-context', 'tool-use', 'multimodal'],
  },
  'google/gemini-3.6-flash': {
    provider: 'google',
    name: 'Gemini 3.6 Flash',
    description: 'Gemini 3.6 Flash (新一代主力 / 1M 上下文 / 较 3.5 Flash 更省 token / 多模态)',
    releasedAt: '2026-07-21',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'google/gemini-3.5-flash-lite': {
    provider: 'google',
    name: 'Gemini 3.5 Flash-Lite',
    description: 'Gemini 3.5 Flash-Lite (低成本轻量档 / 工具调用 / 原生多模态 / 长上下文)',
    releasedAt: '2026-07-21',
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
  'qwen/qwen3.7-max': {
    provider: 'qwen',
    name: 'Qwen3.7 Max',
    description: 'Qwen3.7 Max (旗舰档 / 1M 上下文 / 原生深度思考 / 工具调用)',
    releasedAt: '2026-05-20',
    capabilities: ['thinking', 'tool-use', 'long-context'],
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
