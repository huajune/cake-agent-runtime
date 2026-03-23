/**
 * 发送消息类型枚举（企业级接口 v2）
 * 参考文档: https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445/315430966e0
 *
 * 注意：此枚举用于发送消息 API，与回调消息的 MessageType 不同
 * - 回调消息的 MessageType 在 message-callback.enum.ts 中定义
 * - 发送 API 只支持部分消息类型
 */
export enum SendMessageType {
  FILE = 1, // 文件消息
  VOICE = 2, // 语音消息
  CONTACT_CARD = 3, // 名片消息
  EMOJI = 5, // 表情消息
  IMAGE = 6, // 图片消息
  TEXT = 7, // 文本消息
  LOCATION = 8, // 位置消息
  MINIPROGRAM = 9, // 小程序消息
  LINK = 12, // 链接消息
  VIDEO = 13, // 视频消息
  VIDEO_ACCOUNT = 14, // 视频号消息
}
