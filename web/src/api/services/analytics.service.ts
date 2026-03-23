import type { DashboardData, MetricsData } from '../types/analytics.types';
import type { MessageRecord } from '../types/chat.types';
import type { SystemInfo } from '../types/agent.types';
import type { DashboardOverviewData, SystemMonitoringData, TrendsData } from '../types/analytics.types';
import { api, unwrapResponse } from '../client';

export type { DashboardOverviewData, SystemMonitoringData, TrendsData } from '../types/analytics.types';

// ==================== Dashboard API ====================

export async function getDashboard(timeRange: string) {
  const { data } = await api.get(`/analytics/dashboard?range=${timeRange}`);
  return unwrapResponse<DashboardData>(data);
}

export async function getDashboardOverview(timeRange: string) {
  const { data } = await api.get(`/analytics/dashboard/overview?range=${timeRange}`);
  return unwrapResponse<DashboardOverviewData>(data);
}

export async function getSystemMonitoring() {
  const { data } = await api.get('/analytics/dashboard/system');
  return unwrapResponse<SystemMonitoringData>(data);
}

export async function getTrendsData(timeRange: string) {
  const { data } = await api.get(`/analytics/stats/trends?range=${timeRange}`);
  return unwrapResponse<TrendsData>(data);
}

export async function clearData() {
  const { data } = await api.post('/analytics/clear');
  return unwrapResponse(data);
}

export async function clearCache(type: 'metrics' | 'history' | 'agent' | 'all') {
  const { data } = await api.post(`/analytics/cache/clear?type=${type}`);
  return unwrapResponse(data);
}

// ==================== Metrics API ====================

export async function getMetrics() {
  const { data } = await api.get('/analytics/metrics');
  return unwrapResponse<MetricsData>(data);
}

export async function getRecentMessages() {
  const { data } = await api.get('/analytics/recent-messages');
  return unwrapResponse<MessageRecord[]>(data);
}

export async function getSystemInfo() {
  const { data } = await api.get('/analytics/system');
  return unwrapResponse(data) as SystemInfo;
}
