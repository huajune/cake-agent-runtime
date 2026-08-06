/**
 * 消息处理相关常量配置
 * 这些值通常不需要频繁修改，直接硬编码
 */

// ==================== 消息聚合配置（部分硬编码） ====================

// 注意：消息聚合采用 debounce 机制，只有一个动态参数：
// - initialMergeWindowMs: 距离最后一条消息的静默窗口（默认 3000ms）
//   存储于 Supabase hosting_config 表，通过 Dashboard 动态调整
//   （旧的环境变量 INITIAL_MERGE_WINDOW_MS / MAX_MERGED_MESSAGES 已废弃）

// 以下配置为硬编码，不支持动态调整
export const ENABLE_MESSAGE_MERGE = true; // 启用消息聚合

// ==================== 消息发送配置 ====================

export const ENABLE_MESSAGE_SPLIT_SEND = true; // 启用消息分段发送
export const MESSAGE_SPLIT_MAX_SEGMENTS = 6; // 单次 AI 回复最多拆成 6 条企微消息

// ==================== 打字延迟配置（部分硬编码） ====================

// 注意：以下配置支持 Dashboard 动态调整，默认值在 SupabaseService 中定义
// - TYPING_SPEED_CHARS_PER_SEC: 打字速度（默认 8 字符/秒）
// - ENABLE_TYPING_THINKING_TIME: 启用思考时间（默认 true）

// 以下配置为硬编码，不支持动态调整
export const TYPING_MIN_DELAY_MS = 800; // 最小延迟
export const TYPING_MAX_DELAY_MS = 8000; // 最大延迟
export const TYPING_RANDOM_VARIATION = 0.2; // 随机波动比例 (±20%)

// ==================== 消息历史配置 ====================

export const MAX_HISTORY_PER_CHAT = 60; // 每会话最大消息数（历史按条数封顶，无 TTL）

// ==================== HTTP 配置 ====================

export const HTTP_CLIENT_TIMEOUT = 30000; // HTTP 超时（30 秒）
