import { IsString, IsNotEmpty, IsObject, IsBoolean, IsNumber } from 'class-validator';

/**
 * ========================================
 * 枚举类型定义
 * ========================================
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

/**
 * ========================================
 * Payload 接口定义（消息内容）
 * ========================================
 */

/**
 * 引用消息结构
 */
export interface QuoteMessage {
  messageId: string; // 被引用消息ID
  wxid: string; // 被引用人的wxid
  nickname: string; // 被引用人昵称
  type: string; // 消息类型
  content: any; // 消息内容
  timestamp: string; // 时间戳
}

/**
 * 文本消息 Payload (messageType=7)
 */
export interface TextPayload {
  text: string; // 消息内容
  pureText?: string; // 不含艾特信息的纯文本内容
  mention?: string[]; // 被@人的wxid列表
  quoteMessage?: QuoteMessage; // 引用消息
}

/**
 * 图片消息 Payload (messageType=6)
 */
export interface ImagePayload {
  imageUrl: string; // 压缩图片URL
  width: number; // 缩略图宽度
  height: number; // 缩略图高度
  size?: number; // 文件大小（字节）
  artwork?: {
    // 原图数据
    url: string; // 原图URL
    width: number; // 原图宽度
    height: number; // 原图高度
  };
}

/**
 * 文件消息 Payload (messageType=1)
 */
export interface FilePayload {
  name: string; // 文件名
  fileUrl: string; // 文件下载URL
  size: number; // 文件大小（字节）
}

/**
 * 语音消息 Payload (messageType=2)
 */
export interface VoicePayload {
  voiceUrl: string; // 语音URL
  duration: number; // 时长（秒）
  text?: string; // 语音转文字结果
  md5?: string; // 文件MD5
}

/**
 * 名片消息 Payload (messageType=3)
 */
export interface ContactCardPayload {
  avatar: string; // 头像URL
  name: string; // 姓名
  wxid: string; // 系统微信号
  weixin?: string; // 员工ID
  alias?: string; // 备注名
  nickname?: string; // 昵称
}

/**
 * 位置消息 Payload (messageType=8)
 */
export interface LocationPayload {
  name: string; // 位置名称
  address: string; // 详细地址
  latitude: string; // 纬度
  longitude: string; // 经度
  accuracy?: number; // 精度
}

/**
 * 小程序消息 Payload (messageType=9)
 */
export interface MiniProgramPayload {
  appid: string; // 小程序appid
  title: string; // 标题
  pagePath?: string; // 页面路径
  description?: string; // 描述
  thumbnailUrl?: string; // 缩略图URL
}

/**
 * 视频消息 Payload (messageType=13)
 */
export interface VideoPayload {
  videoUrl: string; // 视频URL
  duration: number; // 时长（秒）
  thumbnailUrl?: string; // 缩略图URL
}

/**
 * 链接消息 Payload (messageType=12)
 */
export interface LinkPayload {
  title: string; // 标题
  description?: string; // 描述
  url: string; // 链接URL
  thumbnailUrl?: string; // 缩略图URL
}

/**
 * 企微系统消息 Payload (messageType=10001)
 */
export interface WecomSystemPayload {
  // 根据实际需要定义企微系统消息的结构
  type: string;
  content: any;
}

/**
 * ========================================
 * 企业级消息回调数据结构
 * ========================================
 */

/**
 * 企业级消息回调 DTO
 * 参考文档: https://s.apifox.cn/34adc635-40ac-4161-8abb-8cd1eea9f445/315430968e0
 *
 * 说明：
 * - 用于接收所有消息类型（用户发送和托管账号发送的消息都会触发该回调）
 * - 若回调请求超时，则会重试，最多5次
 * - 如果3分钟内10个回调重试全失败，将禁用该地址30分钟
 * - 建议进行异步处理，避免处理超时导致重复推送
 */
export class EnterpriseMessageCallbackDto {
  @IsString()
  @IsNotEmpty()
  orgId: string; // 企业ID

  @IsString()
  groupId?: string; // 小组ID（可选）

  @IsString()
  @IsNotEmpty()
  token: string; // 企业级token

  @IsString()
  @IsNotEmpty()
  botId: string; // bot账号ID

  @IsString()
  botUserId?: string; // bot用户ID（可选）

  @IsString()
  @IsNotEmpty()
  imBotId: string; // 托管账号成员的系统wxid

  @IsString()
  @IsNotEmpty()
  chatId: string; // 对话ID（表示一个bot和一个客户）

  @IsString()
  imContactId?: string; // 联系人的系统ID（企业级接口使用，私聊时有值）

  @IsNumber()
  @IsNotEmpty()
  messageType: MessageType; // 消息类型（0-17、9999、10000-10002）

  @IsString()
  @IsNotEmpty()
  messageId: string; // 消息ID

  @IsString()
  @IsNotEmpty()
  timestamp: string; // 消息时间戳

  @IsBoolean()
  isSelf?: boolean; // 是否托管账号自己发送（可选字段，企微回调中可能缺失）

  @IsNumber()
  @IsNotEmpty()
  source: MessageSource; // 消息来源（0-15）

  @IsNumber()
  @IsNotEmpty()
  contactType: ContactType; // 客户类型（0-3）

  @IsObject()
  @IsNotEmpty()
  payload:
    | TextPayload
    | ImagePayload
    | FilePayload
    | VoicePayload
    | ContactCardPayload
    | LocationPayload
    | MiniProgramPayload
    | VideoPayload
    | LinkPayload
    | WecomSystemPayload
    | any; // 消息内容（根据messageType变化）

  // 群聊相关字段（仅群聊消息返回）
  imRoomId?: string; // 群聊的系统 room ID
  roomName?: string; // 群聊名称
  roomWecomChatId?: string; // 群聊的企微 chatId

  // 其他可选字段
  contactName?: string; // 客户名称
  externalUserId?: string; // 外部用户ID
  coworker?: boolean; // 是否为同事
  avatar?: string; // 头像URL

  // 内部标记（用于动态 API 选择，不参与验证）
  _apiType?: 'enterprise' | 'group'; // API 类型标记（企业级 or 小组级）
}

/**
 * 企业级消息回调响应数据结构
 */
export interface EnterpriseMessageCallbackResponse {
  errcode: number; // 错误码，0 表示成功
  errmsg: string; // 错误信息，成功时为 "success"
}

/**
 * ========================================
 * 类型守卫函数
 * ========================================
 */

/**
 * 判断 payload 是否为文本消息
 */
export function isTextPayload(type: MessageType, payload: any): payload is TextPayload {
  return type === MessageType.TEXT && payload && typeof payload.text === 'string';
}

/**
 * 判断 payload 是否为图片消息
 */
export function isImagePayload(type: MessageType, payload: any): payload is ImagePayload {
  return type === MessageType.IMAGE && payload && typeof payload.imageUrl === 'string';
}

/**
 * 判断 payload 是否为文件消息
 */
export function isFilePayload(type: MessageType, payload: any): payload is FilePayload {
  return type === MessageType.FILE && payload && typeof payload.fileUrl === 'string';
}

/**
 * 判断 payload 是否为语音消息
 */
export function isVoicePayload(type: MessageType, payload: any): payload is VoicePayload {
  return type === MessageType.VOICE && payload && typeof payload.voiceUrl === 'string';
}

/**
 * 判断 payload 是否为视频消息
 */
export function isVideoPayload(type: MessageType, payload: any): payload is VideoPayload {
  return type === MessageType.VIDEO && payload && typeof payload.videoUrl === 'string';
}

/**
 * 判断 payload 是否为链接消息
 */
export function isLinkPayload(type: MessageType, payload: any): payload is LinkPayload {
  return type === MessageType.LINK && payload && typeof payload.url === 'string';
}

/**
 * 判断 payload 是否为位置消息
 */
export function isLocationPayload(type: MessageType, payload: any): payload is LocationPayload {
  return type === MessageType.LOCATION && payload && typeof payload.address === 'string';
}

/**
 * 判断 payload 是否为企微系统消息
 */
export function isWecomSystemPayload(
  type: MessageType,
  payload: any,
): payload is WecomSystemPayload {
  return type === MessageType.WECOM_SYSTEM && payload && typeof payload.type === 'string';
}

/**
 * ========================================
 * 小组级消息回调数据结构
 * ========================================
 */

/**
 * 小组级消息回调 DTO（包装在 data 字段中）
 * 参考文档: https://s.apifox.cn/acec6592-fec1-443b-8563-10c4a10e64c4
 *
 * 说明：
 * - 用于接收小组级托管平台的消息回调
 * - 数据结构与企业级有所不同，需要通过适配器转换
 */
export class GroupMessageCallbackDto {
  @IsString()
  @IsNotEmpty()
  messageId: string; // 消息ID

  @IsString()
  @IsNotEmpty()
  chatId: string; // 对话ID

  @IsString()
  avatar?: string; // 头像URL

  @IsString()
  roomTopic?: string; // 群聊主题（群聊时有值）

  @IsString()
  roomId?: string; // 群聊ID（群聊时有值）

  @IsString()
  @IsNotEmpty()
  contactName: string; // 联系人名称

  @IsString()
  @IsNotEmpty()
  contactId: string; // 联系人系统ID（对应企业级的 imContactId）

  @IsObject()
  @IsNotEmpty()
  payload:
    | TextPayload
    | ImagePayload
    | FilePayload
    | VoicePayload
    | ContactCardPayload
    | LocationPayload
    | MiniProgramPayload
    | VideoPayload
    | LinkPayload
    | WecomSystemPayload
    | any; // 消息内容

  @IsNumber()
  @IsNotEmpty()
  type: MessageType; // 消息类型（对应企业级的 messageType）

  @IsNumber()
  @IsNotEmpty()
  timestamp: number; // 消息时间戳（毫秒）

  @IsString()
  @IsNotEmpty()
  token: string; // 小组级token

  @IsNumber()
  @IsNotEmpty()
  contactType: ContactType; // 客户类型

  @IsBoolean()
  coworker?: boolean; // 是否为同事

  @IsString()
  @IsNotEmpty()
  botId: string; // bot账号ID

  @IsString()
  @IsNotEmpty()
  botWxid: string; // bot微信ID（对应企业级的 imBotId）

  @IsString()
  botWeixin?: string; // bot用户ID（对应企业级的 botUserId）

  @IsBoolean()
  isSelf?: boolean; // 是否自己发送

  @IsString()
  externalUserId?: string; // 外部用户ID

  @IsString()
  roomWecomChatId?: string; // 企微群聊ID

  @IsBoolean()
  mentionSelf?: boolean; // 是否@自己
}

/**
 * 小组级消息回调包装器（外层结构）
 */
export class GroupMessageCallbackWrapperDto {
  @IsObject()
  @IsNotEmpty()
  data: GroupMessageCallbackDto; // 实际消息数据包装在 data 字段中
}
