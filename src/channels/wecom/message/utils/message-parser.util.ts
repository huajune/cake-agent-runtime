import {
  EnterpriseMessageCallbackDto,
  isTextPayload,
  isLocationPayload,
  LocationPayload,
} from '../dto/message-callback.dto';
import { ScenarioType } from '@agent';

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
    // 提取文本内容（优先使用 pureText，不含 @ 信息）
    const content = isTextPayload(messageData.messageType, messageData.payload)
      ? messageData.payload.pureText || messageData.payload.text
      : '';

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
   * 支持文本消息和位置消息
   */
  static extractContent(messageData: EnterpriseMessageCallbackDto): string {
    // 文本消息
    if (isTextPayload(messageData.messageType, messageData.payload)) {
      return messageData.payload.pureText || messageData.payload.text;
    }

    // 位置消息 - 转换为自然语言描述
    if (isLocationPayload(messageData.messageType, messageData.payload)) {
      return this.formatLocationAsText(messageData.payload);
    }

    return '';
  }

  /**
   * 将位置信息格式化为自然语言文本
   * 用于发送给 AI 处理
   */
  static formatLocationAsText(payload: LocationPayload): string {
    const { name, address } = payload;

    // 如果名称和地址相同，只显示一个
    if (name === address) {
      return `[位置分享] ${address}`;
    }

    // 如果有名称，显示"名称（地址）"格式
    if (name && address) {
      return `[位置分享] ${name}（${address}）`;
    }

    // 只有地址
    if (address) {
      return `[位置分享] ${address}`;
    }

    // 只有名称
    if (name) {
      return `[位置分享] ${name}`;
    }

    return '[位置分享] 未知位置';
  }

  /**
   * 判断消息场景
   * 当前业务只有候选人私聊咨询这一个场景，预留 messageData 以便未来扩展
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static determineScenario(_messageData?: EnterpriseMessageCallbackDto): ScenarioType {
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
}
