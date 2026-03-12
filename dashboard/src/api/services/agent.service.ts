import type { HealthStatus } from '../types/agent.types';
import type { AvailableModelsResponse, ConfiguredToolsResponse } from '../types/agent.types';
import { api, unwrapResponse } from '../client';

export type { AvailableModelsResponse, ConfiguredToolsResponse } from '../types/agent.types';

export async function getAvailableModels() {
  const { data } = await api.get('/agent/available-models');
  return unwrapResponse<AvailableModelsResponse>(data);
}

export async function getConfiguredTools() {
  const { data } = await api.get('/agent/configured-tools');
  return unwrapResponse<ConfiguredToolsResponse>(data);
}

export async function getHealthStatus() {
  const { data } = await api.get('/agent/health');
  return unwrapResponse<HealthStatus>(data);
}
