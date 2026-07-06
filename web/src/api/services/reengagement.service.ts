import type {
  ReengagementScenario,
  ReengagementStatsItem,
  ReengagementTouchRecord,
} from '../types/reengagement.types';
import { api, unwrapResponse } from '../client';

export type {
  ReengagementEvent,
  ReengagementScenario,
  ReengagementStatsItem,
  ReengagementTouchRecord,
} from '../types/reengagement.types';

// ==================== 二次触发追溯 API ====================

export async function getReengagementRecords(options?: {
  startDate?: string;
  endDate?: string;
  status?: string;
  scenarioCode?: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  if (options?.status) params.set('status', options.status);
  if (options?.scenarioCode) params.set('scenarioCode', options.scenarioCode);
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  const { data } = await api.get(`/analytics/reengagement-records?${params.toString()}`);
  return unwrapResponse<ReengagementTouchRecord[]>(data);
}

export async function getReengagementRecordDetail(touchKey: string) {
  // touchKey 含冒号，必须走 query 参数并 encodeURIComponent
  const { data } = await api.get(
    `/analytics/reengagement-records/detail?touchKey=${encodeURIComponent(touchKey)}`,
  );
  return unwrapResponse<ReengagementTouchRecord>(data);
}

export async function getReengagementScenarios() {
  const { data } = await api.get('/analytics/reengagement-scenarios');
  return unwrapResponse<ReengagementScenario[]>(data);
}

export async function getReengagementStats(options?: { startDate?: string; endDate?: string }) {
  const params = new URLSearchParams();
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  const { data } = await api.get(`/analytics/reengagement-stats?${params.toString()}`);
  return unwrapResponse<ReengagementStatsItem[]>(data);
}
