/**
 * 消息处理相关常量配置
 * 这些值通常不需要频繁修改，直接硬编码
 */

// ==================== 消息聚合配置（部分硬编码） ====================

// 注意：以下配置支持 Dashboard 动态调整，默认值在 SupabaseService 中定义
// - INITIAL_MERGE_WINDOW_MS: 聚合等待窗口（默认 3000ms）
// - MAX_MERGED_MESSAGES: 最大聚合条数（默认 3）

// 以下配置为硬编码，不支持动态调整
export const ENABLE_MESSAGE_MERGE = true; // 启用消息聚合
export const MAX_RETRY_COUNT = 1; // Agent 响应后重试次数
export const MIN_MESSAGE_LENGTH_TO_RETRY = 2; // 触发重试的最小消息长度
export const COLLECT_MESSAGES_DURING_PROCESSING = true; // 处理期间收集新消息

// 消息溢出策略
export type OverflowStrategyType = 'take-latest' | 'take-all';
export const OVERFLOW_STRATEGY: OverflowStrategyType = 'take-latest';

// ==================== 消息发送配置 ====================

export const ENABLE_MESSAGE_SPLIT_SEND = true; // 启用消息分段发送

// ==================== 打字延迟配置（部分硬编码） ====================

// 注意：以下配置支持 Dashboard 动态调整，默认值在 SupabaseService 中定义
// - TYPING_SPEED_CHARS_PER_SEC: 打字速度（默认 8 字符/秒）
// - ENABLE_TYPING_THINKING_TIME: 启用思考时间（默认 true）

// 以下配置为硬编码，不支持动态调整
export const TYPING_MIN_DELAY_MS = 800; // 最小延迟
export const TYPING_MAX_DELAY_MS = 8000; // 最大延迟
export const TYPING_RANDOM_VARIATION = 0.2; // 随机波动比例 (±20%)

// ==================== 消息历史配置 ====================

export const MAX_HISTORY_PER_CHAT = 60; // 每会话最大消息数
export const HISTORY_TTL_MS = 7200000; // 历史消息 TTL（2 小时）

// ==================== HTTP 配置 ====================

export const HTTP_CLIENT_TIMEOUT = 30000; // HTTP 超时（30 秒）
