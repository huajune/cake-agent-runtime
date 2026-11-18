/**
 * 模型数据字典 — 已登记模型的静态目录
 *
 * RegistryService 根据已注册 Provider 过滤出当前可用模型。
 * 新增模型只需在对应 Provider 下加一行。
 */

export enum ModelProvider {
  Qwen = 'qwen',
  DeepSeek = 'deepseek',
}

export const SUPPORTED_MODEL_ID_PATTERN = new RegExp(
  `^(${Object.values(ModelProvider).join('|')})/[^/\\s]+$`,
);

export const DEEPSEEK_FLASH_MODEL_ID = 'deepseek/deepseek-flash';

/** 模型核心能力标签 */
export type ModelCapability = 'thinking' | 'tool-use' | 'multimodal' | 'long-context';

/** 模型元信息 */
export interface ModelEntry {
  provider: ModelProvider;
  name: string;
  description: string;
  capabilities?: ModelCapability[];
  releasedAt: string;
}

export const MODEL_DICTIONARY: Record<string, ModelEntry> = {
  [DEEPSEEK_FLASH_MODEL_ID]: {
    provider: ModelProvider.DeepSeek,
    name: 'DeepSeek V4.1 Flash',
    description: 'DeepSeek V4.1 Flash (图像理解 / 工具调用 / 1M 上下文)',
    releasedAt: '2026-10-17',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'deepseek/deepseek-v4-pro': {
    provider: ModelProvider.DeepSeek,
    name: 'DeepSeek V4 Pro',
    description: 'DeepSeek V4 Pro (旗舰推理 / Agent 能力 / 工具调用 / 1M 上下文)',
    releasedAt: '2026-04-24',
    capabilities: ['thinking', 'tool-use', 'long-context'],
  },

  // ==================== 通义千问 (Qwen) ====================
  'qwen/qwen3.7-plus': {
    provider: ModelProvider.Qwen,
    name: 'Qwen3.7 Plus',
    description: 'Qwen3.7 Plus (增强推理 / 工具调用 / 图文多模态 / 长上下文)',
    releasedAt: '2026-06-02',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen4-max': {
    provider: ModelProvider.Qwen,
    name: 'Qwen4 Max',
    description: 'Qwen4 Max (旗舰推理 / 1M 上下文 / 结构化输出 / 原生多模态 / 工具调用)',
    releasedAt: '2026-11-16',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen3.8-max': {
    provider: ModelProvider.Qwen,
    name: 'Qwen3.8 Max',
    description: 'Qwen3.8 Max (2.4T MoE 旗舰档 / 1M 上下文 / 结构化输出 / 原生多模态 / 工具调用)',
    releasedAt: '2026-08-03',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen3.7-flash': {
    provider: ModelProvider.Qwen,
    name: 'Qwen3.7 Flash',
    description: 'Qwen3.7 Flash (高速低成本档 / 1M 上下文 / 原生多模态 / 工具调用)',
    releasedAt: '2026-07-21',
    capabilities: ['thinking', 'tool-use', 'multimodal', 'long-context'],
  },
  'qwen/qwen3-vl-plus': {
    provider: ModelProvider.Qwen,
    name: 'Qwen3 VL Plus',
    description: 'Qwen3 VL Plus (视觉理解 / 图片与文档 OCR / 工具调用 / 多模态 / 长上下文)',
    releasedAt: '2026-01-12',
    capabilities: ['multimodal', 'tool-use', 'thinking', 'long-context'],
  },
};

/** 模型 ID 类型 */
export type ModelId = keyof typeof MODEL_DICTIONARY;

/** Normalize persisted IDs as well as caller overrides before routing. */
export function supportedModelId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!SUPPORTED_MODEL_ID_PATTERN.test(id)) return '';
  if (id === 'deepseek/deepseek-v4-flash' || id === 'deepseek/deepseek-v4-flash-vision-exp')
    return DEEPSEEK_FLASH_MODEL_ID;
  return id;
}

// Old environment files and saved Dashboard chains may still contain a retired provider.
const retiredProviders = new Set([
  'anthropic',
  'google',
  'openai',
  'openrouter',
  'moonshotai',
  'ohmygpt',
  'gateway',
]);

export function configuredFallbackModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const models = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    const supported = supportedModelId(id);
    if (supported) models.add(supported);
    else if (id.includes('/') && retiredProviders.has(id.split('/')[0]))
      models.add(DEEPSEEK_FLASH_MODEL_ID);
  }
  return [...models];
}

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

export function resolveModelCapabilities(modelId: string): ModelCapability[] | undefined {
  return MODEL_DICTIONARY[supportedModelId(modelId)]?.capabilities;
}

/** 判断模型是否具备指定能力（未登记时保守返回 false） */
export function modelHasCapability(modelId: string, capability: ModelCapability): boolean {
  return resolveModelCapabilities(modelId)?.includes(capability) ?? false;
}

export function supportsVision(modelId: string): boolean {
  return modelHasCapability(modelId, 'multimodal');
}
