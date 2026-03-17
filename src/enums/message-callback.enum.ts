/**
 * 企微回调消息枚举定义
 * 用于接收托管平台消息回调中的枚举类型
 */

/**
 * 消息类型枚举
 * 参考文档: https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445/315430968e0
 */
export enum MessageType {
  UNKNOWN = 0, // 未知
  FILE = 1, // 文件
  VOICE = 2, // 语音
  CONTACT_CARD = 3, // 名片
  CHAT_HISTORY = 4, // 聊天历史
  EMOTION = 5, // 表情
  IMAGE = 6, // 图片
  TEXT = 7, // 文字
  LOCATION = 8, // 位置
  MINI_PROGRAM = 9, // 小程序
  MONEY = 10, // 钱相关
  REVOKE = 11, // 撤回消息
  LINK = 12, // 图文消息
  VIDEO = 13, // 视频
  CHANNELS = 14, // 视频号
  CALL_RECORD = 15, // 通话记录
  GROUP_SOLITAIRE = 16, // 群聊接龙
  ROOM_INVITE = 9999, // 入群邀请
  SYSTEM = 10000, // 系统消息
  WECOM_SYSTEM = 10001, // 企微系统消息
}

/**
 * 客户类型枚举
 */
export enum ContactType {
  UNKNOWN = 0, // 未知类型的联系人
  PERSONAL_WECHAT = 1, // 个人微信
  OFFICIAL_ACCOUNT = 2, // 公众号
  ENTERPRISE_WECHAT = 3, // 企业微信
}

/**
 * 消息来源枚举
 * 定义企微机器人托管平台消息回调中的 source 字段取值
 */
export enum MessageSource {
  /** 手机推送过来的消息 */
  MOBILE_PUSH = 0,

  /** 聚合聊天手动发送消息 */
  AGGREGATED_CHAT_MANUAL = 1,

  /** 高级群发/群聊私聊sop */
  ADVANCED_GROUP_SEND_SOP = 2,

  /** 自动回复 */
  AUTO_REPLY = 3,

  /** 创建群聊 */
  CREATE_GROUP = 4,

  /** 其他机器人回复 */
  OTHER_BOT_REPLY = 5,

  /** api发消息 */
  API_SEND = 6,

  /** 新客户应答sop */
  NEW_CUSTOMER_ANSWER_SOP = 7,

  /** api群发 */
  API_GROUP_SEND = 8,

  /** 标签sop */
  TAG_SOP = 9,

  /** 多群转播 */
  MULTI_GROUP_FORWARD = 11,

  /** 多群重播 */
  MULTI_GROUP_REPLAY = 12,

  /** 自动结束会话 */
  AUTO_END_CONVERSATION = 13,

  /** 定时消息 */
  SCHEDULED_MESSAGE = 14,

  /** ai回复 */
  AI_REPLY = 15,
}

/**
 * 消息来源描述映射
 * 用于日志记录和调试
 */
export const MESSAGE_SOURCE_DESCRIPTIONS: Record<number, string> = {
  [MessageSource.MOBILE_PUSH]: '手机推送过来的消息',
  [MessageSource.AGGREGATED_CHAT_MANUAL]: '聚合聊天手动发送消息',
  [MessageSource.ADVANCED_GROUP_SEND_SOP]: '高级群发/群聊私聊sop',
  [MessageSource.AUTO_REPLY]: '自动回复',
  [MessageSource.CREATE_GROUP]: '创建群聊',
  [MessageSource.OTHER_BOT_REPLY]: '其他机器人回复',
  [MessageSource.API_SEND]: 'api发消息',
  [MessageSource.NEW_CUSTOMER_ANSWER_SOP]: '新客户应答sop',
  [MessageSource.API_GROUP_SEND]: 'api群发',
  [MessageSource.TAG_SOP]: '标签sop',
  [MessageSource.MULTI_GROUP_FORWARD]: '多群转播',
  [MessageSource.MULTI_GROUP_REPLAY]: '多群重播',
  [MessageSource.AUTO_END_CONVERSATION]: '自动结束会话',
  [MessageSource.SCHEDULED_MESSAGE]: '定时消息',
  [MessageSource.AI_REPLY]: 'ai回复',
};

/**
 * 获取消息来源描述
 * @param source 消息来源值
 * @returns 消息来源描述文本
 */
export function getMessageSourceDescription(source: number): string {
  return MESSAGE_SOURCE_DESCRIPTIONS[source] || `未知来源(${source})`;
}
