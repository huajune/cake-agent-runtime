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
  QuoteMessage,
  TextPayload,
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

    // 文本消息（含微信原生引用气泡）
    if (isTextPayload(messageType, payload)) {
      const baseText = payload.pureText || payload.text;
      const quoted = this.formatQuoteMessage(payload);
      return quoted ? `${quoted}\n${baseText}` : baseText;
    }

    // 位置消息 - 转换为自然语言描述
    if (isLocationPayload(messageType, payload)) {
      return this.formatLocationAsText(payload);
    }

    // 语音消息 - 文字描述 + 引导发文字
    if (isVoicePayload(messageType, payload)) {
      return this.formatVoiceAsText(payload);
    }

    // 表情消息 - 文字标记（vision 描述完成后由 ImageDescriptionService 回写为
    // `[表情消息] {description}`；这里只用占位前缀，避免硬编码"候选人/招募经理"主语）
    if (isEmotionPayload(messageType, payload)) {
      return '[表情消息]';
    }

    // 图片消息 - 文字标记（同上，role 由 chat_messages.role 区分，不放在内容里）
    if (isImagePayload(messageType, payload)) {
      return '[图片消息]';
    }

    // 小程序消息
    if (isMiniProgramPayload(messageType, payload)) {
      return this.formatMiniProgramAsText(payload);
    }

    return '';
  }

  /**
   * 把微信原生引用气泡（payload.quoteMessage）渲染成 Agent 可读的引用前缀。
   *
   * 业务背景：候选人长按 bot 之前发的某条岗位/规则消息选择"引用"后再回复时，
   * 企微回调里 `payload.quoteMessage` 会带被引用消息的发言人和原文。若不渲染进
   * Agent 看到的对话内容，模型只看到"这个是每天吗"这种孤立指代，就会把"这个"
   * 误绑到对话中最近的岗位（badcase #19 / `recvhYwaqtr5dr`）。
   */
  private static formatQuoteMessage(payload: TextPayload): string | null {
    const quote = payload.quoteMessage;
    if (!quote) return null;
    const text = MessageParser.extractQuoteText(quote);
    if (!text) return null;
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return null;
    const speaker = quote.nickname?.trim() || '对方';
    const snippet = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
    return `[引用 ${speaker}：${snippet}]`;
  }

  /**
   * 从引用消息的 content 字段抽出可读文本。content 类型按 quote.type 变化（文本/图片/语音…），
   * 这里只处理文本场景；其他类型用 [图片消息]/[语音消息] 之类的占位符。
   */
  private static extractQuoteText(quote: QuoteMessage): string {
    const c = quote.content;
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') {
      const obj = c as { text?: unknown; pureText?: unknown };
      if (typeof obj.pureText === 'string') return obj.pureText;
      if (typeof obj.text === 'string') return obj.text;
    }
    // 非文本引用：根据被引用消息的 type 给个占位
    const t = String(quote.type ?? '').toLowerCase();
    if (t === '6' || t === 'image') return '[图片消息]';
    if (t === '5' || t === 'emotion') return '[表情消息]';
    if (t === '2' || t === 'voice') return '[语音消息]';
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
