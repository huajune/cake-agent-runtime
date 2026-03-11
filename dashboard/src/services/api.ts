import axios from 'axios';

const api = axios.create({
  baseURL: '',
  timeout: 10000,
});

// 监控数据类型
export interface MonitoringStats {
  totalMessages: number;
  totalReplies: number;
  activeUsers: number;
  avgResponseTime: number;
  successRate: number;
}

export interface AlertItem {
  id: string;
  type: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  timestamp: string;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memory: {
    used: number;
    total: number;
  };
  cpu: number;
}

// API 函数
export async function fetchMonitoringStats(): Promise<any> {
  const { data } = await api.get('/analytics/metrics');
  return data.data || data;
}

export async function fetchAlerts(): Promise<AlertItem[]> {
  const { data } = await api.get('/analytics/alerts?range=today');
  return data.data || data || [];
}

export async function fetchSystemHealth(): Promise<SystemHealth> {
  const { data } = await api.get('/analytics/dashboard/system');
  return data.data || data;
}

export async function fetchAgentHealth(): Promise<{ status: string; models?: string[] }> {
  const { data } = await api.get('/agent/health');
  return data.data || data;
}

export default api;
