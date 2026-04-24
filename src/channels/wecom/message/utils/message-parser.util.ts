import {
  EnterpriseMessageCallbackDto,
  isTextPayload,
  isLocationPayload,
  isVoicePayload,
  isEmotionPayload,
  isImagePayload,
  isMiniProgramPayload,
  LocationPayload,
  VoicePayload,
  MiniProgramPayload,
} from '../ingress/message-callback.dto';
import { MessageType } from '@enums/message-callback.enum';
import { ScenarioType } from '@enums/agent.enum';

/**
 * 消息解析工具类
 * 提供消息数据的解析和转换功能
 */
export class MessageParser {
  /**
   * 解析消息数据
   * 提取文本内容和基本信息，用于后续处理
   */
  static parse(messageData: EnterpriseMessageCallbackDto) {
    const content = this.extractContent(messageData);

    // 根据 imRoomId 是否有值来判断是否为群聊
    const isRoom = !!messageData.imRoomId;

    // 企业级接口 v2：使用回调数据中的 imContactId 字段（私聊时有值）
    const imContactId = isRoom ? undefined : messageData.imContactId;

    return {
      token: messageData.token,
      messageId: messageData.messageId,
      messageType: messageData.messageType,
      content,
      roomId: messageData.imRoomId, // 群聊的系统 room ID（仅群聊消息有值）
      roomName: messageData.roomName, // 群聊名称（仅群聊消息有值）
      roomWecomChatId: messageData.roomWecomChatId, // 群聊的企微 chatId（仅群聊消息有值）
      isRoom,
      chatId: messageData.chatId,
      imBotId: messageData.imBotId, // 托管账号的系统wxid（企业级接口 v2）
      imContactId, // 客户的系统wxid（企业级接口 v2，私聊时使用）
      imRoomId: messageData.imRoomId, // 群聊的系统wxid（企业级接口 v2，群聊时使用）
      botWxid: messageData.imBotId, // 兼容字段
      botId: messageData.botId,
      orgId: messageData.orgId,
      managerName: messageData.botUserId, // 企微回调中的 botUserId 即招募经理昵称
      isSelf: messageData.isSelf,
      timestamp: parseInt(messageData.timestamp),
      payload: messageData.payload,
      contactType: messageData.contactType,
      contactName: messageData.contactName,
      externalUserId: messageData.externalUserId,
      coworker: messageData.coworker,
      avatar: messageData.avatar,
      _apiType: messageData._apiType, // 传递 API 类型标记（小组级 or 企业级）
    };
  }

  /**
   * 提取消息文本内容
   * 支持：文本、位置、语音、表情、图片、小程序
   */
  static extractContent(messageData: EnterpriseMessageCallbackDto): string {
    const { messageType, payload } = messageData;

    // 文本消息
    if (isTextPayload(messageType, payload)) {
      return payload.pureText || payload.text;
    }

    // 位置消息 - 转换为自然语言描述
    if (isLocationPayload(messageType, payload)) {
      return this.formatLocationAsText(payload);
    }

    // 语音消息 - 文字描述 + 引导发文字
    if (isVoicePayload(messageType, payload)) {
      return this.formatVoiceAsText(payload);
    }

    // 表情消息 - 文字标记（表情图片同样通过 image part 传入 Agent 做 vision 识别）
    if (isEmotionPayload(messageType, payload)) {
      return '[表情消息] 候选人发送了一个表情';
    }

    // 图片消息 - 文字标记（实际图片通过 image part 传入 Agent）
    if (isImagePayload(messageType, payload)) {
      return '[图片消息] 候选人发送了一张图片';
    }

    // 小程序消息
    if (isMiniProgramPayload(messageType, payload)) {
      return this.formatMiniProgramAsText(payload);
    }

    return '';
  }

  /**
   * 提取视觉 URL（图片 / 表情）
   *
   * 表情和图片走同一条 vision 识别管线；差异仅体现在写回 DB 的前缀上（见
   * `ImageDescriptionService` / `save_image_description` 工具）。
   */
  static extractImageUrl(messageData: EnterpriseMessageCallbackDto): string | null {
    const { messageType, payload } = messageData;

    if (messageType === MessageType.IMAGE && isImagePayload(messageType, payload)) {
      return payload.imageUrl || payload.url || null;
    }

    if (messageType === MessageType.EMOTION && isEmotionPayload(messageType, payload)) {
      return payload.imageUrl || null;
    }

    return null;
  }

  /**
   * 判断消息携带的视觉类型：IMAGE / EMOTION / null。
   *
   * 供下游区分写回 DB 的前缀（`[图片消息]` vs `[表情消息]`）。
   */
  static extractVisualMessageType(
    messageData: EnterpriseMessageCallbackDto,
  ): MessageType.IMAGE | MessageType.EMOTION | null {
    if (this.extractImageUrl(messageData) === null) return null;
    if (messageData.messageType === MessageType.EMOTION) return MessageType.EMOTION;
    return MessageType.IMAGE;
  }

  /**
   * 将语音消息格式化为自然语言文本
   */
  static formatVoiceAsText(payload: VoicePayload): string {
    // 优先使用 STT 转写文本
    if (payload.text && payload.text.trim().length > 0) {
      const duration = payload.duration ? `${Math.round(payload.duration)}秒` : '';
      return `[语音转文字${duration ? `，时长${duration}` : ''}] ${payload.text.trim()}`;
    }
    const duration = payload.duration ? `${Math.round(payload.duration)}秒` : '未知时长';
    return `[语音消息] 时长${duration}`;
  }

  /**
   * 将小程序消息格式化为自然语言文本
   */
  static formatMiniProgramAsText(payload: MiniProgramPayload): string {
    const { title, description } = payload;
    if (description) {
      return `[小程序] ${title} - ${description}`;
    }
    return `[小程序] ${title}`;
  }

  /**
   * 将位置信息格式化为自然语言文本
   * 用于发送给 AI 处理
   */
  static formatLocationAsText(payload: LocationPayload): string {
    const { name, address, latitude, longitude } = payload;

    // 构建位置描述
    let location: string;
    if (name && address && name !== address) {
      location = `${name}（${address}）`;
    } else if (address) {
      location = address;
    } else if (name) {
      location = name;
    } else {
      location = '未知位置';
    }

    // 附加经纬度（供后续智能推荐使用）
    const coords =
      latitude !== undefined && longitude !== undefined ? ` [经纬度:${latitude},${longitude}]` : '';

    return `[位置分享] ${location}${coords}`;
  }

  /**
   * 判断消息场景
   * 当前业务只有候选人私聊咨询这一个场景
   */
  static determineScenario(): ScenarioType {
    return ScenarioType.CANDIDATE_CONSULTATION;
  }

  /**
   * 格式化当前时间为中文可读格式
   * 用于注入到用户消息中，让 Agent 具有时间感知能力
   * @param timestamp 可选的时间戳（毫秒），默认使用当前时间
   * @returns 格式化的时间字符串，如 "2025-12-03 17:30 星期三"
   */
  static formatCurrentTime(timestamp?: number): string {
    // 使用北京时间 (Asia/Shanghai)
    const date = timestamp ? new Date(timestamp) : new Date();

    // 使用 Intl.DateTimeFormat 获取北京时间各部分
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'long',
    });

    const parts = formatter.formatToParts(date);
    const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '';

    const year = getPart('year');
    const month = getPart('month');
    const day = getPart('day');
    const hour = getPart('hour');
    const minute = getPart('minute');
    const weekday = getPart('weekday');

    return `${year}-${month}-${day} ${hour}:${minute} ${weekday}`;
  }

  /**
   * 为用户消息注入时间上下文
   * 在消息末尾添加时间标注
   * @param content 原始消息内容
   * @param timestamp 消息时间戳（毫秒）
   * @returns 注入时间后的消息内容
   */
  static injectTimeContext(content: string, timestamp?: number): string {
    const timeStr = this.formatCurrentTime(timestamp);
    return `${content}\n[消息发送时间：${timeStr}]`;
  }

  /**
   * 剥离 injectTimeContext 追加的时间后缀。
   *
   * 用于下游需要对消息做正则/模式匹配（如识别"我是xx"加好友硬规则）时，
   * 先还原成用户原始发出的文本，避免被时间后缀破坏锚点（badcase
   * `batch_69e9bba2536c9654026522da_*`）。
   */
  static stripTimeContext(content: string): string {
    if (!content) return content;
    return content.replace(/\n\[消息发送时间：[^\]]*\]\s*$/u, '');
  }
}
