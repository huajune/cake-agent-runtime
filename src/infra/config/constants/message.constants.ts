/**
 * 消息处理相关常量配置
 * 这些值通常不需要频繁修改，直接硬编码
 */

// ==================== 消息聚合配置（部分硬编码） ====================

// 注意：消息聚合采用 debounce 机制，有两个动态维度，均存储于 Supabase system_config 表、
// 通过 Dashboard 动态调整：
// - 是否启用聚合（MESSAGE_MERGE_ENABLED，见 SystemConfigService；ENABLE_MESSAGE_MERGE 环境变量
//   只作为首次落库的种子默认值）
// - initialMergeWindowMs: 距离最后一条消息的静默窗口（默认 3000ms）
//   （旧的环境变量 INITIAL_MERGE_WINDOW_MS / MAX_MERGED_MESSAGES 已废弃）

// 下面这个常量当前无人 import（开关实际读 DB），仅留作历史参考
export const ENABLE_MESSAGE_MERGE = true; // 启用消息聚合

// ==================== 消息发送配置 ====================

export const ENABLE_MESSAGE_SPLIT_SEND = true; // 启用消息分段发送
// 单次 AI 回复的分段软上限：MessageSplitter 尽量控制在 6 条内，但岗位卡片/表单块要保持
// 原子性，无法在不破坏结构的前提下继续合并时允许超出
export const MESSAGE_SPLIT_MAX_SEGMENTS = 6;

// ==================== 打字延迟配置（部分硬编码） ====================

// 注意：以下配置支持 Dashboard 动态调整，默认值在 hosting-config.types.ts 的
// DEFAULT_AGENT_REPLY_CONFIG 中定义，经 SystemConfigService 下发
// - TYPING_SPEED_CHARS_PER_SEC: 打字速度（默认 8 字符/秒）

// 以下配置为硬编码，不支持动态调整
export const TYPING_MIN_DELAY_MS = 800; // 最小延迟
export const TYPING_MAX_DELAY_MS = 8000; // 最大延迟
export const TYPING_RANDOM_VARIATION = 0.2; // 随机波动比例 (±20%)

// ==================== HTTP 配置 ====================

export const HTTP_CLIENT_TIMEOUT = 30000; // HTTP 超时（30 秒）
