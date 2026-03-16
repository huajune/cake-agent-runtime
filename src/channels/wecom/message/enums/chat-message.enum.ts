/**
 * ========================================
 * 聊天消息存储枚举（数据库专用）
 * ========================================
 *
 * 设计原则：
 * 1. 与外部契约（企微回调）解耦，使用独立的英文字符串枚举
 * 2. 数据库存储可读性优先，便于直接查询和调试
 * 3. 提供双向映射工具函数，实现外部数字 ↔ 内部字符串转换
 */

/**
 * 存储用消息类型枚举（英文字符串）
 * 用于 Supabase chat_messages 表的 message_type 字段
 */
export enum StorageMessageType {
  UNKNOWN = 'UNKNOWN',
  FILE = 'FILE',
  VOICE = 'VOICE',
  CONTACT_CARD = 'CONTACT_CARD',
  CHAT_HISTORY = 'CHAT_HISTORY',
  EMOTION = 'EMOTION',
  IMAGE = 'IMAGE',
  TEXT = 'TEXT',
  LOCATION = 'LOCATION',
  MINI_PROGRAM = 'MINI_PROGRAM',
  MONEY = 'MONEY',
  REVOKE = 'REVOKE',
  LINK = 'LINK',
  VIDEO = 'VIDEO',
  CHANNELS = 'CHANNELS',
  CALL_RECORD = 'CALL_RECORD',
  GROUP_SOLITAIRE = 'GROUP_SOLITAIRE',
  ROOM_INVITE = 'ROOM_INVITE',
  SYSTEM = 'SYSTEM',
  WECOM_SYSTEM = 'WECOM_SYSTEM',
}

/**
 * 存储用消息来源枚举（英文字符串）
 * 用于 Supabase chat_messages 表的 source 字段
 */
export enum StorageMessageSource {
  MOBILE_PUSH = 'MOBILE_PUSH',
  AGGREGATED_CHAT_MANUAL = 'AGGREGATED_CHAT_MANUAL',
  ADVANCED_GROUP_SEND_SOP = 'ADVANCED_GROUP_SEND_SOP',
  AUTO_REPLY = 'AUTO_REPLY',
  CREATE_GROUP = 'CREATE_GROUP',
  OTHER_BOT_REPLY = 'OTHER_BOT_REPLY',
  API_SEND = 'API_SEND',
  NEW_CUSTOMER_ANSWER_SOP = 'NEW_CUSTOMER_ANSWER_SOP',
  API_GROUP_SEND = 'API_GROUP_SEND',
  TAG_SOP = 'TAG_SOP',
  MULTI_GROUP_FORWARD = 'MULTI_GROUP_FORWARD',
  MULTI_GROUP_REPLAY = 'MULTI_GROUP_REPLAY',
  AUTO_END_CONVERSATION = 'AUTO_END_CONVERSATION',
  SCHEDULED_MESSAGE = 'SCHEDULED_MESSAGE',
  AI_REPLY = 'AI_REPLY',
  UNKNOWN = 'UNKNOWN',
}

/**
 * 存储用客户类型枚举（英文字符串）
 * 用于 Supabase chat_messages 表的 contact_type 字段
 */
export enum StorageContactType {
  UNKNOWN = 'UNKNOWN',
  PERSONAL_WECHAT = 'PERSONAL_WECHAT',
  OFFICIAL_ACCOUNT = 'OFFICIAL_ACCOUNT',
  ENTERPRISE_WECHAT = 'ENTERPRISE_WECHAT',
}

/**
 * ========================================
 * 外部数字 → 内部字符串 映射表
 * ========================================
 */

/**
 * 企微消息类型数字 → 存储字符串映射
 */
const MESSAGE_TYPE_NUM_TO_STR: Record<number, StorageMessageType> = {
  0: StorageMessageType.UNKNOWN,
  1: StorageMessageType.FILE,
  2: StorageMessageType.VOICE,
  3: StorageMessageType.CONTACT_CARD,
  4: StorageMessageType.CHAT_HISTORY,
  5: StorageMessageType.EMOTION,
  6: StorageMessageType.IMAGE,
  7: StorageMessageType.TEXT,
  8: StorageMessageType.LOCATION,
  9: StorageMessageType.MINI_PROGRAM,
  10: StorageMessageType.MONEY,
  11: StorageMessageType.REVOKE,
  12: StorageMessageType.LINK,
  13: StorageMessageType.VIDEO,
  14: StorageMessageType.CHANNELS,
  15: StorageMessageType.CALL_RECORD,
  16: StorageMessageType.GROUP_SOLITAIRE,
  9999: StorageMessageType.ROOM_INVITE,
  10000: StorageMessageType.SYSTEM,
  10001: StorageMessageType.WECOM_SYSTEM,
};

/**
 * 企微消息来源数字 → 存储字符串映射
 */
const MESSAGE_SOURCE_NUM_TO_STR: Record<number, StorageMessageSource> = {
  0: StorageMessageSource.MOBILE_PUSH,
  1: StorageMessageSource.AGGREGATED_CHAT_MANUAL,
  2: StorageMessageSource.ADVANCED_GROUP_SEND_SOP,
  3: StorageMessageSource.AUTO_REPLY,
  4: StorageMessageSource.CREATE_GROUP,
  5: StorageMessageSource.OTHER_BOT_REPLY,
  6: StorageMessageSource.API_SEND,
  7: StorageMessageSource.NEW_CUSTOMER_ANSWER_SOP,
  8: StorageMessageSource.API_GROUP_SEND,
  9: StorageMessageSource.TAG_SOP,
  11: StorageMessageSource.MULTI_GROUP_FORWARD,
  12: StorageMessageSource.MULTI_GROUP_REPLAY,
  13: StorageMessageSource.AUTO_END_CONVERSATION,
  14: StorageMessageSource.SCHEDULED_MESSAGE,
  15: StorageMessageSource.AI_REPLY,
};

/**
 * 企微客户类型数字 → 存储字符串映射
 */
const CONTACT_TYPE_NUM_TO_STR: Record<number, StorageContactType> = {
  0: StorageContactType.UNKNOWN,
  1: StorageContactType.PERSONAL_WECHAT,
  2: StorageContactType.OFFICIAL_ACCOUNT,
  3: StorageContactType.ENTERPRISE_WECHAT,
};

/**
 * ========================================
 * 转换工具函数
 * ========================================
 */

/**
 * 将企微回调的消息类型数字转换为存储用字符串
 * @param numericType 企微回调中的 messageType 数字值
 * @returns 存储用的英文字符串枚举
 */
export function toStorageMessageType(numericType: number | undefined): StorageMessageType {
  if (numericType === undefined || numericType === null) {
    return StorageMessageType.TEXT; // 默认文本类型
  }
  return MESSAGE_TYPE_NUM_TO_STR[numericType] ?? StorageMessageType.UNKNOWN;
}

/**
 * 将企微回调的消息来源数字转换为存储用字符串
 * @param numericSource 企微回调中的 source 数字值
 * @returns 存储用的英文字符串枚举
 */
export function toStorageMessageSource(numericSource: number | undefined): StorageMessageSource {
  if (numericSource === undefined || numericSource === null) {
    return StorageMessageSource.MOBILE_PUSH; // 默认手机推送
  }
  return MESSAGE_SOURCE_NUM_TO_STR[numericSource] ?? StorageMessageSource.UNKNOWN;
}

/**
 * 将企微回调的客户类型数字转换为存储用字符串
 * @param numericContactType 企微回调中的 contactType 数字值
 * @returns 存储用的英文字符串枚举
 */
export function toStorageContactType(numericContactType: number | undefined): StorageContactType {
  if (numericContactType === undefined || numericContactType === null) {
    return StorageContactType.UNKNOWN; // 默认未知
  }
  return CONTACT_TYPE_NUM_TO_STR[numericContactType] ?? StorageContactType.UNKNOWN;
}

/**
 * ========================================
 * 中文描述映射（用于展示层）
 * ========================================
 */

/**
 * 消息类型中文描述
 */
export const MESSAGE_TYPE_LABELS: Record<StorageMessageType, string> = {
  [StorageMessageType.UNKNOWN]: '未知',
  [StorageMessageType.FILE]: '文件',
  [StorageMessageType.VOICE]: '语音',
  [StorageMessageType.CONTACT_CARD]: '名片',
  [StorageMessageType.CHAT_HISTORY]: '聊天历史',
  [StorageMessageType.EMOTION]: '表情',
  [StorageMessageType.IMAGE]: '图片',
  [StorageMessageType.TEXT]: '文本',
  [StorageMessageType.LOCATION]: '位置',
  [StorageMessageType.MINI_PROGRAM]: '小程序',
  [StorageMessageType.MONEY]: '红包/转账',
  [StorageMessageType.REVOKE]: '撤回消息',
  [StorageMessageType.LINK]: '链接',
  [StorageMessageType.VIDEO]: '视频',
  [StorageMessageType.CHANNELS]: '视频号',
  [StorageMessageType.CALL_RECORD]: '通话记录',
  [StorageMessageType.GROUP_SOLITAIRE]: '群接龙',
  [StorageMessageType.ROOM_INVITE]: '入群邀请',
  [StorageMessageType.SYSTEM]: '系统消息',
  [StorageMessageType.WECOM_SYSTEM]: '企微系统消息',
};

/**
 * 消息来源中文描述
 */
export const MESSAGE_SOURCE_LABELS: Record<StorageMessageSource, string> = {
  [StorageMessageSource.MOBILE_PUSH]: '手机推送',
  [StorageMessageSource.AGGREGATED_CHAT_MANUAL]: '聚合聊天手动发送',
  [StorageMessageSource.ADVANCED_GROUP_SEND_SOP]: '高级群发/SOP',
  [StorageMessageSource.AUTO_REPLY]: '自动回复',
  [StorageMessageSource.CREATE_GROUP]: '创建群聊',
  [StorageMessageSource.OTHER_BOT_REPLY]: '其他机器人回复',
  [StorageMessageSource.API_SEND]: 'API发送',
  [StorageMessageSource.NEW_CUSTOMER_ANSWER_SOP]: '新客户应答SOP',
  [StorageMessageSource.API_GROUP_SEND]: 'API群发',
  [StorageMessageSource.TAG_SOP]: '标签SOP',
  [StorageMessageSource.MULTI_GROUP_FORWARD]: '多群转播',
  [StorageMessageSource.MULTI_GROUP_REPLAY]: '多群重播',
  [StorageMessageSource.AUTO_END_CONVERSATION]: '自动结束会话',
  [StorageMessageSource.SCHEDULED_MESSAGE]: '定时消息',
  [StorageMessageSource.AI_REPLY]: 'AI回复',
  [StorageMessageSource.UNKNOWN]: '未知来源',
};

/**
 * 客户类型中文描述
 */
export const CONTACT_TYPE_LABELS: Record<StorageContactType, string> = {
  [StorageContactType.UNKNOWN]: '未知',
  [StorageContactType.PERSONAL_WECHAT]: '个人微信',
  [StorageContactType.OFFICIAL_ACCOUNT]: '公众号',
  [StorageContactType.ENTERPRISE_WECHAT]: '企业微信',
};

/**
 * 获取消息类型的中文描述
 */
export function getMessageTypeLabel(type: StorageMessageType): string {
  return MESSAGE_TYPE_LABELS[type] ?? '未知';
}

/**
 * 获取消息来源的中文描述
 */
export function getMessageSourceLabel(source: StorageMessageSource): string {
  return MESSAGE_SOURCE_LABELS[source] ?? '未知来源';
}

/**
 * 获取客户类型的中文描述
 */
export function getContactTypeLabel(contactType: StorageContactType): string {
  return CONTACT_TYPE_LABELS[contactType] ?? '未知';
}
