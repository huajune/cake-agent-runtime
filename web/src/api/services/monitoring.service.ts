import type { WorkerStatus } from '../types/monitoring.types';
import type { WorkerConcurrencyResponse, GroupInfo } from '../types/monitoring.types';
import { api, unwrapResponse } from '../client';

export type { WorkerConcurrencyResponse, GroupInfo } from '../types/monitoring.types';

// ==================== 开关控制 API ====================

export async function getAiReplyStatus() {
  const { data } = await api.get('/config/ai-reply-status');
  return unwrapResponse<{ enabled: boolean }>(data);
}

export async function toggleAiReply(enabled: boolean) {
  const { data } = await api.post('/config/toggle-ai-reply', { enabled });
  return unwrapResponse<{ enabled: boolean; message: string }>(data);
}

export async function toggleMessageMerge(enabled: boolean) {
  const { data } = await api.post('/config/toggle-message-merge', { enabled });
  return unwrapResponse<{ enabled: boolean; message: string }>(data);
}

// ==================== Worker API ====================

export async function getWorkerStatus() {
  const { data } = await api.get('/message/worker-status');
  return unwrapResponse<WorkerStatus>(data);
}

export async function setWorkerConcurrency(concurrency: number) {
  const { data } = await api.post('/message/worker-concurrency', { concurrency });
  return unwrapResponse<WorkerConcurrencyResponse>(data);
}

export async function getGroupList() {
  const token = import.meta.env.VITE_ENTERPRISE_TOKEN || '9eaebbf614104879b81c2da7c41819bd';
  const { data } = await api.get(`/group/list?token=${token}`);
  const groups = unwrapResponse<GroupInfo[]>(data);
  return groups || [];
}
