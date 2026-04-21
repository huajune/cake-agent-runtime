import type {
  HealthStatus,
  AgentHealthRaw,
  AvailableModelsResponse,
  ConfiguredToolsResponse,
  ModelOption,
  ModelCapability,
} from '../types/agent.types';
import { api, unwrapResponse } from '../client';

export type {
  AvailableModelsResponse,
  ConfiguredToolsResponse,
  ModelOption,
  ModelCapability,
} from '../types/agent.types';

interface RawModelEntry {
  id: string;
  provider?: string;
  name?: string;
  description?: string;
  capabilities?: ModelCapability[];
}

/**
 * 获取可用模型列表
 * 后端: GET /agent/models -> { models: [{id, provider, name, description, capabilities}], total }
 */
export async function getAvailableModels(): Promise<AvailableModelsResponse> {
  const { data } = await api.get('/agent/models');
  const raw = unwrapResponse<{ models: RawModelEntry[]; total: number }>(data);
  const models: ModelOption[] =
    raw.models?.map((m) => ({
      id: m.id,
      provider: m.provider ?? '',
      name: m.name ?? m.id,
      description: m.description ?? '',
      capabilities: m.capabilities ?? [],
    })) ?? [];
  return {
    availableModels: models.map((m) => m.id),
    models,
    defaultModel: models[0]?.id ?? '',
    defaultModelAvailable: (raw.total ?? 0) > 0,
    lastRefreshTime: new Date().toISOString(),
  };
}

/**
 * 获取已配置的工具列表
 * 后端: GET /agent/health -> { tools: { builtIn, mcp, total } }
 */
export async function getConfiguredTools(): Promise<ConfiguredToolsResponse> {
  const { data } = await api.get('/agent/health');
  const raw = unwrapResponse<AgentHealthRaw>(data);
  const tools = raw.tools;
  const allTools = [...(tools?.builtIn ?? []), ...(tools?.mcp ?? [])];
  return {
    configuredTools: allTools,
    count: tools?.total ?? allTools.length,
    allAvailable: allTools.length > 0,
    lastRefreshTime: new Date().toISOString(),
  };
}

/**
 * 获取健康状态
 * 后端: GET /agent/health -> { status, providers, roles, scenarios, tools, message }
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const { data } = await api.get('/agent/health');
  const raw = unwrapResponse<AgentHealthRaw>(data);

  const providers = raw.providers ?? [];
  const roles = raw.roles ?? {};
  const tools = raw.tools ?? { builtIn: [], mcp: [], total: 0 };

  return {
    status: raw.status === 'healthy' ? 'healthy' : raw.status === 'degraded' ? 'degraded' : 'unhealthy',
    message: raw.message ?? '',
    providers: {
      count: providers.length,
      list: providers,
    },
    roles: {
      count: Object.keys(roles).length,
      details: roles,
    },
    tools: {
      builtInCount: tools.builtIn.length,
      mcpCount: tools.mcp.length,
      total: tools.total,
      builtIn: tools.builtIn,
      mcp: tools.mcp,
    },
    checks: {
      redis: raw.checks?.redis ?? false,
      supabase: raw.checks?.supabase ?? false,
    },
  };
}
