import type {
  HealthStatus,
  AgentHealthRaw,
  AvailableModelsResponse,
  ConfiguredToolsResponse,
} from '../types/agent.types';
import { api, unwrapResponse } from '../client';

export type { AvailableModelsResponse, ConfiguredToolsResponse } from '../types/agent.types';

/**
 * 获取可用模型列表
 * 后端: GET /agent/models -> { models: [{id, provider, name}], total }
 */
export async function getAvailableModels(): Promise<AvailableModelsResponse> {
  const { data } = await api.get('/agent/models');
  const raw = unwrapResponse<{ models: { id: string }[]; total: number }>(data);
  return {
    availableModels: raw.models?.map((m) => m.id) ?? [],
    defaultModel: raw.models?.[0]?.id ?? '',
    defaultModelAvailable: (raw.total ?? 0) > 0,
    lastRefreshTime: new Date().toISOString(),
  };
}

/**
 * 获取已配置的工具列表
 * 后端: GET /agent/health -> { scenarios: [...] }
 */
export async function getConfiguredTools(): Promise<ConfiguredToolsResponse> {
  const { data } = await api.get('/agent/health');
  const raw = unwrapResponse<AgentHealthRaw>(data);
  const tools = raw.scenarios ?? [];
  return {
    configuredTools: tools,
    count: tools.length,
    allAvailable: tools.length > 0,
    lastRefreshTime: new Date().toISOString(),
  };
}

/**
 * 获取健康状态
 * 后端: GET /agent/health -> { status, providers, roles, scenarios, message }
 * 适配为前端 HealthStatus 格式
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const { data } = await api.get('/agent/health');
  const raw = unwrapResponse<AgentHealthRaw>(data);

  const providers = raw.providers ?? [];
  const roles = raw.roles ?? {};
  const scenarios = raw.scenarios ?? [];
  const roleCount = Object.keys(roles).length;

  return {
    status: raw.status === 'healthy' ? 'healthy' : raw.status === 'degraded' ? 'degraded' : 'unhealthy',
    message: raw.message ?? '',
    models: {
      availableCount: providers.length,
      configuredCount: roleCount,
      configuredAvailable: roleCount > 0,
      allConfiguredModelsAvailable: providers.length > 0 && roleCount > 0,
    },
    tools: {
      availableCount: scenarios.length,
      configuredCount: scenarios.length,
      allAvailable: scenarios.length > 0,
    },
  };
}
