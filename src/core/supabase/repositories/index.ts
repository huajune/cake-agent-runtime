/**
 * Supabase Repository 统一导出
 *
 * 所有 Repository 通过此文件统一导出，方便其他模块引用
 */

// ==================== 基类 ====================
export { BaseRepository } from './base.repository';

// ==================== 系统配置 ====================
export {
  SystemConfigRepository,
  SystemConfigKey,
  SystemConfig,
  AgentReplyConfig,
  DEFAULT_AGENT_REPLY_CONFIG,
} from './system-config.repository';

// ==================== 用户托管 ====================
export {
  UserHostingRepository,
  UserHostingStatus,
  UserActivityRecord,
} from './user-hosting.repository';

// ==================== 群组黑名单 ====================
export { GroupBlacklistRepository, GroupBlacklistItem } from './group-blacklist.repository';

// ==================== 聊天消息 ====================
export {
  ChatMessageRepository,
  ChatMessageRecord,
  ChatMessageInput,
} from './chat-message.repository';

// ==================== 监控统计 ====================
export {
  MonitoringRepository,
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyTrendData,
  HourlyTrendData,
} from './monitoring.repository';

// ==================== 消息处理记录 ====================
export {
  MessageProcessingRepository,
  MessageProcessingRecordInput,
} from './message-processing.repository';

// ==================== 预约统计 ====================
export { BookingRepository, BookingRecordInput, BookingStats } from './booking.repository';

// ==================== 策略配置 ====================
export { StrategyConfigRepository } from '../../../agent/strategy/strategy-config.repository';
