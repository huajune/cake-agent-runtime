import { ScenarioType } from '@agent';

/**
 * 告警错误类型（简化版）
 */
export type AlertErrorType = 'agent' | 'message' | 'delivery' | 'system' | 'merge' | 'unknown';

/**
 * 监控系统接口定义
 */

/**
 * 时间范围类型
 */
export type TimeRange = 'today' | 'week' | 'month';

export interface ToolUsageMetric {
  name: string;
  total: number;
  percentage: number; // 使用占比
}

export interface ScenarioUsageMetric {
  name: string;
  total: number;
  percentage: number;
}

export interface MonitoringErrorLog {
  messageId: string;
  timestamp: number;
  error: string;
  alertType?: AlertErrorType;
}

export interface MonitoringGlobalCounters {
  totalMessages: number;
  totalSuccess: number;
  totalFailure: number;
  totalAiDuration: number;
  totalSendDuration: number;
  totalFallback: number; // 总降级次数
  totalFallbackSuccess: number; // 降级成功次数（用户无感知）
}

export interface MonitoringSnapshot {
  version: number;
  savedAt: number;
  detailRecords: MessageProcessingRecord[];
  hourlyStats: HourlyStats[];
  errorLogs: MonitoringErrorLog[];
  globalCounters: MonitoringGlobalCounters;
  activeUsers: string[];
  activeChats: string[];
  currentProcessing: number;
  peakProcessing: number;
}

export interface ResponseMinuteTrendPoint {
  minute: string;
  avgDuration: number;
  messageCount: number;
  successRate: number;
}

export interface AlertTrendPoint {
  minute: string;
  count: number;
}

/**
 * 每日统计数据
 */
export interface DailyStats {
  date: string; // "2025-11-21"
  tokenUsage: number; // 当日 token 消耗
  uniqueUsers: number; // 当日咨询人头数（去重）
  messageCount: number; // 消息数
  successCount: number; // 成功数
  avgDuration: number; // 平均响应时间
}

/**
 * 今日咨询用户
 */
export interface TodayUser {
  odId: string;
  odName: string;
  groupId?: string; // 小组 ID（可选）
  groupName?: string; // 小组名称（可选）
  chatId: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: number; // 首次活跃时间
  lastActiveAt: number; // 最后活跃时间
  isPaused: boolean; // 是否暂停托管
}

export interface BusinessMetricTrendPoint {
  minute: string;
  consultations: number; // 咨询人数
  bookingAttempts: number; // 预约尝试次数
  successfulBookings: number; // 成功预约次数
  conversionRate: number; // 转化率 (%)
  bookingSuccessRate: number; // 预约成功率 (%)
}

/**
 * Agent 响应消息部分 - 文本类型
 */
export interface AgentTextPart {
  type: 'text';
  text: string;
  state?: 'done' | 'streaming';
}

/**
 * Agent 响应消息部分 - 动态工具类型
 */
export interface AgentDynamicToolPart {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  state: 'pending' | 'running' | 'output-available' | 'error';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

/**
 * Agent 响应消息部分（联合类型）
 */
export type AgentMessagePart = AgentTextPart | AgentDynamicToolPart;

/**
 * Agent 响应消息
 */
export interface AgentResponseMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  parts: AgentMessagePart[];
}

/**
 * 简单消息结构（用于历史消息展示）
 */
export interface SimpleMessageItem {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 模型配置（花卷 API 多模型配置）
 */
export interface ModelConfigParams {
  chatModel?: string; // 主对话模型
  classifyModel?: string; // 意图分类模型
  replyModel?: string; // 回复生成模型
}

export interface AgentInputParams {
  conversationId: string;
  userMessage: string;
  historyCount: number; // 历史消息数量
  historyMessages?: SimpleMessageItem[]; // 历史消息详情（用于调试）
  model?: string;
  allowedTools?: string[];
  contextStrategy?: string;
  prune?: boolean;
  // 模型配置（花卷 API 多模型配置）
  modelConfig?: ModelConfigParams;
  // Prompt 相关字段（仅记录是否传入和长度，不记录内容）
  hasSystemPrompt?: boolean;
  systemPromptLength?: number;
  hasContext?: boolean;
  contextLength?: number;
  hasToolContext?: boolean;
  toolContextLength?: number;
  // 调试字段
  _mergedContextKeys?: string[];
  // 完整原始入参 JSON（超长字段已省略，用于 Dashboard 展示调试）
  rawParams?: string;
  // rawParams 来源：'ChatRequest' 表示使用实际 API 请求体，'agentParams' 表示回退到处理器参数
  // 当错误发生在 prepareRequest 之前（如参数验证失败），chatRequest 为 undefined，此时回退到 agentParams
  rawParamsSource?: 'ChatRequest' | 'agentParams';
}

/**
 * 完整 HTTP 响应结构（包含状态码、headers 等）
 */
export interface RawHttpResponse {
  // HTTP 状态码
  status: number;
  statusText: string;
  // 响应头（选择性保留关键字段）
  headers?: {
    'content-type'?: string;
    'x-request-id'?: string;
    'x-correlation-id'?: string;
    [key: string]: string | undefined;
  };
  // 响应时间（毫秒）
  responseTime?: number;
}

/**
 * Agent 调用记录（用于 Dashboard 排障）
 *
 * 设计原则：
 * - request: 完整的 ChatRequest 请求体
 * - response: 完整的 ChatResponse 响应体
 * - http: HTTP 层面的元信息（可选）
 * - isFallback: 是否为降级响应
 */
export interface AgentInvocationRecord {
  /** 实际发送给 /api/v1/chat 的请求体（ChatRequest） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: Record<string, any>;

  /** Agent API 的原始响应（ChatResponse） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: Record<string, any>;

  /** 是否为降级响应 */
  isFallback: boolean;

  /** HTTP 响应元信息（可选） */
  http?: RawHttpResponse;
}

export interface MonitoringMetadata {
  scenario?: ScenarioType;
  tools?: string[];
  tokenUsage?: number;
  replyPreview?: string;
  replySegments?: number;
  isFallback?: boolean;
  alertType?: AlertErrorType;
  batchId?: string; // 聚合批次ID
  isPrimary?: boolean; // 是否为主消息
  /** Agent 调用记录（完整的请求/响应，用于排障） */
  agentInvocation?: AgentInvocationRecord;
}

/**
 * 消息处理记录
 */
export interface MessageProcessingRecord {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  scenario?: ScenarioType;

  // 时间戳
  receivedAt: number; // 收到消息时间
  aiStartAt?: number; // AI 开始处理时间
  aiEndAt?: number; // AI 完成处理时间
  sendStartAt?: number; // 开始发送消息时间
  sendEndAt?: number; // 完成发送消息时间

  // 耗时（毫秒）
  totalDuration?: number; // 总耗时
  aiDuration?: number; // AI 处理耗时
  sendDuration?: number; // 消息发送耗时
  queueDuration?: number; // 排队耗时（消息接收到 Worker 开始处理）
  prepDuration?: number; // 预处理耗时（Worker 内部，AI 调用前的准备工作）

  // 状态
  status: 'processing' | 'success' | 'failure';
  error?: string;
  isFallback?: boolean; // 是否使用了降级
  fallbackSuccess?: boolean; // 降级是否成功（用户无感知）

  // 消息内容（用于调试）
  messagePreview?: string; // 消息预览（前50字符）
  replyPreview?: string; // AI 回复预览
  tokenUsage?: number; // Token 使用
  tools?: string[]; // 使用的工具
  replySegments?: number; // 实际发送的回复条数
  alertType?: AlertErrorType;

  // 聚合关系
  batchId?: string; // 聚合批次ID（多条消息聚合时使用）
  isPrimary?: boolean; // 是否为主消息（调用 Agent 的那条）

  /** Agent 调用记录（完整的请求/响应，用于排障） */
  agentInvocation?: AgentInvocationRecord;
}
export interface AlertTypeMetric {
  type: AlertErrorType | 'unknown';
  count: number;
  percentage: number;
}

/**
 * 小时级别聚合统计
 */
export interface HourlyStats {
  hour: string; // 小时标识，如 "2025-01-15T10:00:00Z"

  // 消息统计
  messageCount: number;
  successCount: number;
  failureCount: number;
  successRate: number; // 成功率（百分比）

  // 耗时统计
  avgDuration: number; // 平均耗时
  minDuration: number; // 最小耗时
  maxDuration: number; // 最大耗时
  p50Duration: number; // P50 百分位
  p95Duration: number; // P95 百分位
  p99Duration: number; // P99 百分位

  avgAiDuration: number; // 平均 AI 处理耗时
  avgSendDuration: number; // 平均发送耗时

  // 活跃度
  activeUsers: number; // 活跃用户数
  activeChats: number; // 活跃会话数
}

/**
 * 仪表盘数据
 */
export interface DashboardData {
  timeRange: TimeRange; // 当前时间范围
  lastWindowHours: number;

  // 总览
  overview: {
    totalMessages: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgDuration: number;
    activeChats: number;
  };

  overviewDelta: {
    totalMessages: number;
    successRate: number;
    avgDuration: number;
  };

  // 降级统计（NEW）
  fallback: {
    totalCount: number; // 总降级次数
    successCount: number; // 降级成功次数
    successRate: number; // 降级成功率
    affectedUsers: number; // 影响用户数
  };

  fallbackDelta: {
    totalCount: number; // 降级次数增长
    successRate: number; // 降级成功率变化
  };

  // 业务指标（NEW）
  business: {
    consultations: {
      total: number; // 总咨询人数
      new: number; // 新增咨询人数（时间范围内）
    };
    bookings: {
      attempts: number; // 预约尝试次数
      successful: number; // 成功预约次数
      failed: number; // 失败预约次数
      successRate: number; // 成功率 (%)
    };
    conversion: {
      consultationToBooking: number; // 咨询到预约转化率 (%)
    };
  };

  businessDelta: {
    consultations: number; // 咨询人数增长
    bookingAttempts: number; // 预约次数增长
    bookingSuccessRate: number; // 预约成功率变化
  };

  usage: {
    tools: ToolUsageMetric[];
    scenarios: ScenarioUsageMetric[];
  };

  queue: {
    currentProcessing: number;
    peakProcessing: number;
    avgQueueDuration: number;
  };

  alertsSummary: {
    total: number; // 当前时间范围内的告警总数（today/week/month）
    lastHour: number; // 近1小时的告警数
    last24Hours: number; // 近24小时的告警数（用于错误率告警检查）
    byType: AlertTypeMetric[];
  };

  // 趋势数据
  trends: {
    hourly: HourlyStats[];
  };

  responseTrend: ResponseMinuteTrendPoint[];
  alertTrend: AlertTrendPoint[];
  businessTrend: BusinessMetricTrendPoint[];

  // 今日用户列表
  todayUsers: TodayUser[];

  // 最近消息（最新50条）
  recentMessages: MessageProcessingRecord[];

  // 错误日志（最新20条）
  recentErrors: MonitoringErrorLog[];

  // 实时状态
  realtime: {
    processingCount: number; // 当前处理中的消息数
    lastMessageTime?: number; // 最后一条消息时间
  };
}

/**
 * 详细指标数据
 */
export interface MetricsData {
  // 详细记录
  detailRecords: MessageProcessingRecord[];

  // 聚合统计
  hourlyStats: HourlyStats[];

  // 全局计数器
  globalCounters: MonitoringGlobalCounters;

  // 百分位统计（全量）
  percentiles: {
    p50: number;
    p95: number;
    p99: number;
    p999: number;
  };

  // 最慢记录
  slowestRecords: MessageProcessingRecord[];

  // 最近5分钟告警数
  recentAlertCount: number;
}
