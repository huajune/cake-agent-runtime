/**
 * Monitoring Hooks (Legacy)
 *
 * ⚠️ 本文件仅保留向后兼容的 re-exports，所有实现已迁移到模块化hooks
 *
 * 新模块位置：dashboard/src/hooks/monitoring/
 * - useChatRecords.ts - 聊天记录相关 (11 个函数) ✅ 已迁移
 * - useUsers.ts - 用户管理 (7 个函数) ✅ 已迁移
 * - useSystemConfig.ts - 系统配置 (9 个函数) ✅ 已迁移
 * - useMetrics.ts - 监控指标 (4 个函数) ✅ 已迁移
 * - useDashboard.ts - Dashboard (4 个函数) ✅ 已迁移
 * - useWorker.ts - 工作队列 (3 个函数) ✅ 已迁移
 *
 * @see https://github.com/duliday/wecom-service/blob/develop/dashboard/src/hooks/monitoring/README.md
 */

// ==================== Re-exports from monitoring/ ====================

// 聊天记录相关 (11 个函数)
export {
  useChatMessages,
  useChatSessions,
  useChatDailyStats,
  useChatSummaryStats,
  useChatSessionsOptimized,
  useChatTrend,
  useChatSessionMessages,
  useMessageStats,
  useSlowestMessages,
  useMessageProcessingRecords,
  useMessageProcessingRecordDetail,
} from './monitoring/useChatRecords';

export type {
  ChatMessage,
  ChatMessagesResponse,
  ChatSession,
} from './monitoring/useChatRecords';

// 用户管理相关 (7 个函数)
export {
  useUserTrend,
  useTodayUsers,
  usePausedUsers,
  useUsers,
  useToggleUserHosting,
  useClearData,
  useClearCache,
} from './monitoring/useUsers';

export type {
  UserTrendData,
  TodayUserData,
  PausedUserData,
} from './monitoring/useUsers';

// 系统配置相关 (9 个函数)
export {
  useAvailableModels,
  useConfiguredTools,
  useAiReplyStatus,
  useBlacklist,
  useAgentReplyConfig,
  useToggleAiReply,
  useToggleMessageMerge,
  useAddToBlacklist,
  useRemoveFromBlacklist,
  useUpdateAgentReplyConfig,
  useResetAgentReplyConfig,
} from './monitoring/useSystemConfig';

export type {
  AvailableModelsResponse,
  ConfiguredToolsResponse,
} from './monitoring/useSystemConfig';

// 监控指标相关 (4 个函数)
export {
  useMetrics,
  useHealthStatus,
  useRecentMessages,
  useSystemInfo,
} from './monitoring/useMetrics';

// Dashboard 相关 (4 个函数)
export {
  useDashboard,
  useDashboardOverview,
  useSystemMonitoring,
  useTrendsData,
} from './monitoring/useDashboard';

export type {
  DashboardOverviewData,
  SystemMonitoringData,
  TrendsData,
} from './monitoring/useDashboard';

// Worker 并发管理 (3 个函数)
export {
  useWorkerStatus,
  useGroupList,
  useSetWorkerConcurrency,
} from './monitoring/useWorker';

export type {
  WorkerConcurrencyResponse,
  GroupInfo,
} from './monitoring/useWorker';

// ==================== End Re-exports ====================
