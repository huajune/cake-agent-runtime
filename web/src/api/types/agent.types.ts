// ==================== Agent 注册信息 ====================

export interface AvailableModelsResponse {
  availableModels: string[];
  defaultModel: string;
  defaultModelAvailable: boolean;
  lastRefreshTime: string;
}

export interface ConfiguredToolsResponse {
  configuredTools: string[];
  count: number;
  allAvailable: boolean;
  lastRefreshTime: string;
}

// ==================== 健康状态 ====================

/** 后端 GET /agent/health 实际返回结构 */
export interface AgentHealthRaw {
  status: string;
  providers: string[];
  roles: Record<string, { model: string }>;
  scenarios: string[];
  message: string;
}

/** 前端展示用的标准化健康状态 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  models: {
    availableCount: number;
    configuredCount: number;
    configuredAvailable: boolean;
    allConfiguredModelsAvailable: boolean;
  };
  tools: {
    availableCount: number;
    configuredCount: number;
    allAvailable: boolean;
  };
}

// ==================== 系统信息 ====================

export interface SystemInfo {
  uptime: number;
  startTime: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  pid: number;
  cwd: string;
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
  cpu: {
    usage: number;
    cores: number;
  };
}
