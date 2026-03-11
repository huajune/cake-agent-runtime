import type {
  BlacklistData,
  AgentReplyConfig,
  AgentReplyConfigResponse,
} from '../types/config.types';
import { api, unwrapResponse } from '../client';

// ==================== 黑名单 API ====================

export async function getBlacklist() {
  const { data } = await api.get('/config/blacklist');
  return unwrapResponse<BlacklistData>(data);
}

export async function addToBlacklist(params: { id: string; type: 'chatId' | 'groupId' }) {
  const { data } = await api.post('/config/blacklist', params);
  return unwrapResponse(data);
}

export async function removeFromBlacklist(params: { id: string; type: 'chatId' | 'groupId' }) {
  const { data } = await api.delete('/config/blacklist', { data: params });
  return unwrapResponse(data);
}

// ==================== Agent 回复配置 API ====================

export async function getAgentReplyConfig() {
  const { data } = await api.get('/config/agent-config');
  return unwrapResponse<AgentReplyConfigResponse>(data);
}

export async function updateAgentReplyConfig(config: Partial<AgentReplyConfig>) {
  const { data } = await api.post('/config/agent-config', config);
  return unwrapResponse<{ config: AgentReplyConfig; message: string }>(data);
}

export async function resetAgentReplyConfig() {
  const { data } = await api.post('/config/agent-config/reset');
  return unwrapResponse<{ config: AgentReplyConfig; message: string }>(data);
}
