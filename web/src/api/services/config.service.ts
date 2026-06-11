import type {
  BlacklistData,
  CandidateBlacklistItem,
  AgentReplyConfig,
  AgentReplyConfigResponse,
  GroupTaskConfig,
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

// ==================== 候选人黑名单 API ====================

export interface AddCandidateBlacklistParams {
  /** 候选人标识：chatId / imContactId / externalUserId 任一 */
  targetId: string;
  /** 拉黑理由（必填，命中告警中展示） */
  reason: string;
  operator?: string;
  /** 拉黑时的会话快照（可选，供回溯） */
  chatId?: string;
  imContactId?: string;
  contactName?: string;
}

export async function getCandidateBlacklist() {
  const { data } = await api.get('/config/candidate-blacklist');
  return unwrapResponse<{ candidates: CandidateBlacklistItem[] }>(data);
}

export async function addCandidateToBlacklist(params: AddCandidateBlacklistParams) {
  const { data } = await api.post('/config/candidate-blacklist', params);
  return unwrapResponse<{ message: string }>(data);
}

export async function removeCandidateFromBlacklist(params: { targetId: string }) {
  const { data } = await api.delete('/config/candidate-blacklist', { data: params });
  return unwrapResponse<{ message: string }>(data);
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

// ==================== 群任务通知配置 API ====================

export async function updateGroupTaskConfig(config: Partial<GroupTaskConfig>) {
  const { data } = await api.post('/config/group-task-config', config);
  return unwrapResponse<{ config: GroupTaskConfig; message: string }>(data);
}
