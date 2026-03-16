import { IsString, IsNotEmpty, IsOptional, IsNumber, IsObject, IsBoolean } from 'class-validator';

/**
 * 发送消息类型枚举（企业级接口 v2）
 * 参考文档: https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445/315430966e0
 *
 * 注意：此枚举用于发送消息 API，与回调消息的 MessageType 不同
 * - 回调消息的 MessageType 在 message-callback.dto.ts 中定义
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

/**
 * @deprecated 请使用 SendMessageType 代替
 * 保留此别名以兼容旧代码
 */
export const MessageType = SendMessageType;

/**
 * 文本消息 payload
 */
export interface TextMessagePayload {
  text: string; // 消息内容
  mention?: string[]; // @人的wxid列表, @all 可以@所有人
  quoteMessageId?: string; // 被引用的消息id
}

/**
 * 图片消息 payload
 */
export interface ImageMessagePayload {
  url: string; // 图片地址
  size?: number; // 图片大小（字节）
}

/**
 * 链接消息 payload
 */
export interface LinkMessagePayload {
  sourceUrl: string; // 跳转地址
  title: string; // 标题
  summary: string; // 描述
  imageUrl: string; // 封面地址
}

/**
 * 文件消息 payload
 */
export interface FileMessagePayload {
  name: string; // 文件名（需要带后缀）
  url: string; // 文件地址
  size?: number; // 文件大小（字节）
}

/**
 * 视频消息 payload
 */
export interface VideoMessagePayload {
  url: string; // 视频地址
  thumbUrl?: string; // 缩略图地址
}

/**
 * 语音消息 payload
 */
export interface VoiceMessagePayload {
  voiceUrl: string; // 语音地址
  duration?: number; // 语音时长（秒）
}

/**
 * 表情消息 payload
 */
export interface EmojiMessagePayload {
  imageUrl: string; // 图片地址
}

/**
 * 位置消息 payload
 */
export interface LocationMessagePayload {
  accuracy: number; // 精确度，默认为15
  address: string; // 地址描述
  latitude: number; // 纬度，北纬为正数
  longitude: number; // 经度，东经为正数
  name: string; // 地址名
}

/**
 * 小程序消息 payload
 */
export interface MiniProgramMessagePayload {
  appid: string; // 小程序原始ID
  username: string; // 小程序ID
  title: string; // 标题
  thumbUrl: string; // 封面图地址
  pagePath: string; // 跳转地址
  description: string; // 描述
  iconUrl?: string; // icon地址
}

/**
 * 视频号消息 payload
 */
export interface VideoAccountMessagePayload {
  avatarUrl: string; // 头像地址
  nickname: string; // 昵称
  feedType: number; // 未知，目前固定为4
  description: string; // 描述
  coverUrl: string; // 封面地址
  extras: string; // 未知，请使用收到的字段信息
  url: string; // 视频号地址
  thumbUrl: string; // 缩略图地址
}

/**
 * 名片消息 payload
 */
export interface ContactCardMessagePayload {
  wxid: string; // 被分享人的系统wxid
  nickname: string; // 被分享人的昵称
  avatar: string; // 被分享人的头像地址
}

/**
 * 消息 payload 联合类型
 */
export type MessagePayload =
  | TextMessagePayload
  | ImageMessagePayload
  | LinkMessagePayload
  | FileMessagePayload
  | VideoMessagePayload
  | VoiceMessagePayload
  | EmojiMessagePayload
  | LocationMessagePayload
  | MiniProgramMessagePayload
  | VideoAccountMessagePayload
  | ContactCardMessagePayload;

/**
 * 发送消息 DTO（企业级接口 v2）
 * 参考文档: https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445/315430966e0
 */
export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  token: string; // 企业级token（必填）

  @IsString()
  @IsNotEmpty()
  imBotId: string; // 托管账号对应成员的系统wxid（必填）

  @IsNumber()
  @IsNotEmpty()
  messageType: SendMessageType; // 消息类型（1-14）

  @IsString()
  @IsOptional()
  externalRequestId?: string; // 会在回调中原样带回，需保证唯一性，两月内幂等

  @IsString()
  @IsOptional()
  imContactId?: string; // 客户的系统wxid（私聊时必填）

  @IsString()
  @IsOptional()
  imRoomId?: string; // 群聊的系统wxid（群聊时必填）

  @IsObject()
  @IsOptional()
  payload?: MessagePayload; // 根据messageType变化的消息内容对象

  @IsBoolean()
  @IsOptional()
  isAnnouncement?: boolean; // 是否群公告（布尔值）

  @IsBoolean()
  @IsOptional()
  isAtAll?: boolean; // 是否艾特所有人（需为群主）
}

/**
 * 发送消息响应（企业级接口 v2）
 */
export interface SendMessageResponse {
  errcode: number; // 错误码，0 表示成功
  errmsg: string; // 错误信息
  requestId: string; // 消息请求id
}
