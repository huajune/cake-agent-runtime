import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatMessageRepository } from '@db/message';
import { MessageParser } from '../utils/message-parser.util';
import { EnhancedMessageHistoryItem } from '../types';
import { SimpleMessage } from '@agent';
import { MessageRole } from '@shared/enums';

/**
 * 消息历史管理服务
 * 负责管理每个会话的消息历史记录，用于 Agent 上下文
 * 使用 Supabase 持久化存储，数据永久保存
 */
@Injectable()
export class MessageHistoryService {
  private readonly logger = new Logger(MessageHistoryService.name);

  // 配置参数
  private readonly maxHistoryForContext: number; // AI 上下文最多取多少条

  constructor(
    private readonly configService: ConfigService,
    private readonly chatMessageRepository: ChatMessageRepository,
  ) {
    // 从环境变量读取历史消息配置
    this.maxHistoryForContext = parseInt(
      this.configService.get<string>('MAX_HISTORY_PER_CHAT', '60'),
      10,
    );

    this.logger.log(
      `消息历史服务已初始化 (Supabase 持久化): AI 上下文最多取 ${this.maxHistoryForContext} 条消息（约 ${Math.floor(this.maxHistoryForContext / 2)} 轮对话）`,
    );
  }

  /**
   * 获取指定会话的历史消息（用于 AI 上下文）
   * 从 Supabase 获取最新 N 条消息，并为每条消息注入时间上下文
   */
  async getHistory(chatId: string): Promise<SimpleMessage[]> {
    try {
      const rawHistory = await this.chatMessageRepository.getChatHistory(
        chatId,
        this.maxHistoryForContext,
      );

      // 为每条历史消息注入时间上下文
      return rawHistory.map((msg) => ({
        role: msg.role as MessageRole,
        content: MessageParser.injectTimeContext(msg.content, msg.timestamp),
      }));
    } catch (error) {
      this.logger.error(`获取会话历史失败 [${chatId}]:`, error);
      return [];
    }
  }

  /**
   * 获取会话历史（用于 Agent 上下文，可排除指定消息ID）
   * 为每条历史消息注入时间上下文
   */
  async getHistoryForContext(chatId: string, excludeMessageId?: string): Promise<SimpleMessage[]> {
    try {
      const history = await this.chatMessageRepository.getChatHistory(
        chatId,
        this.maxHistoryForContext + 1, // 多取一条，以防排除后不够
      );

      if (!excludeMessageId) {
        // 为每条历史消息注入时间上下文
        return history.slice(0, this.maxHistoryForContext).map((msg) => ({
          role: msg.role as MessageRole,
          content: MessageParser.injectTimeContext(msg.content, msg.timestamp),
        }));
      }

      // 需要获取完整详情来过滤 messageId
      const detail = await this.chatMessageRepository.getChatHistoryDetail(chatId);
      const filtered = detail
        .filter((item) => item.messageId !== excludeMessageId)
        .slice(-this.maxHistoryForContext);

      // 为每条历史消息注入时间上下文
      return filtered.map((item) => ({
        role: item.role as MessageRole,
        content: MessageParser.injectTimeContext(item.content, item.timestamp),
      }));
    } catch (error) {
      this.logger.error(`获取会话历史失败 [${chatId}]:`, error);
      return [];
    }
  }

  /**
   * 添加消息到历史记录（增强版本，支持完整元数据）
   * 保存到 Supabase，永久存储
   * 注意：只存储私聊消息，群聊消息会被自动过滤
   * v1.3: 新增 imBotId, imContactId, contactType, isSelf, payload, avatar, externalUserId 字段
   * @param chatId 会话ID
   * @param role 角色（user 或 assistant）
   * @param content 消息内容
   * @param metadata 可选的元数据（用于飞书同步等高级功能）
   */
  async addMessageToHistory(
    chatId: string,
    role: 'user' | 'assistant',
    content: string,
    metadata?: {
      messageId?: string;
      candidateName?: string;
      managerName?: string;
      orgId?: string;
      botId?: string;
      messageType?: number; // 消息类型：7=文本, 6=图片等
      source?: number; // 消息来源：0=手机推送, 15=AI回复等
      isRoom?: boolean; // 是否群聊（群聊消息不存储）
      // v1.3 新增字段
      imBotId?: string; // 托管账号的系统 wxid
      imContactId?: string; // 联系人系统ID
      contactType?: number; // 客户类型
      isSelf?: boolean; // 是否托管账号自己发送
      payload?: Record<string, unknown>; // 原始消息内容
      avatar?: string; // 用户头像URL
      externalUserId?: string; // 企微外部用户ID
    },
  ): Promise<void> {
    try {
      const messageId =
        metadata?.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      await this.chatMessageRepository.saveChatMessage({
        chatId,
        messageId,
        role,
        content,
        timestamp: Date.now(),
        candidateName: metadata?.candidateName,
        managerName: metadata?.managerName,
        orgId: metadata?.orgId,
        botId: metadata?.botId,
        messageType: metadata?.messageType,
        source: metadata?.source,
        isRoom: metadata?.isRoom,
        // v1.3 新增字段
        imBotId: metadata?.imBotId,
        imContactId: metadata?.imContactId,
        contactType: metadata?.contactType,
        isSelf: metadata?.isSelf,
        payload: metadata?.payload,
        avatar: metadata?.avatar,
        externalUserId: metadata?.externalUserId,
      });
    } catch (error) {
      this.logger.error(`添加消息到历史失败 [${chatId}]:`, error);
    }
  }

  /**
   * 清理指定会话的历史记录
   * 注意：Supabase 模式下此方法不执行实际删除，数据永久保存
   */
  async clearHistory(chatId?: string): Promise<number> {
    if (chatId) {
      this.logger.warn(`Supabase 模式下不支持删除会话历史 [${chatId}]，数据将永久保存`);
    } else {
      this.logger.warn('Supabase 模式下不支持清理所有会话历史');
    }
    return 0;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      storageType: 'supabase',
      maxMessagesForContext: this.maxHistoryForContext,
      retention: 'permanent',
    };
  }

  /**
   * 获取指定会话的历史记录详情（完整版本，包含元数据）
   * @param chatId 会话 ID
   * @returns 会话的历史记录详情
   */
  async getHistoryDetail(chatId: string): Promise<{
    chatId: string;
    messages: Array<EnhancedMessageHistoryItem>;
    messageCount: number;
  } | null> {
    try {
      const messages = await this.chatMessageRepository.getChatHistoryDetail(chatId);

      if (messages.length === 0) {
        return null;
      }

      const enhancedMessages: EnhancedMessageHistoryItem[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        chatId,
        messageId: m.messageId,
        candidateName: m.candidateName,
        managerName: m.managerName,
      }));

      return {
        chatId,
        messages: enhancedMessages,
        messageCount: enhancedMessages.length,
      };
    } catch (error) {
      this.logger.error(`获取会话历史详情失败 [${chatId}]:`, error);
      return null;
    }
  }

  /**
   * 获取所有会话ID列表
   * @returns 所有存在历史记录的会话ID列表
   */
  async getAllChatIds(): Promise<string[]> {
    try {
      return await this.chatMessageRepository.getAllChatIds();
    } catch (error) {
      this.logger.error('获取所有会话ID失败:', error);
      return [];
    }
  }

  /**
   * 获取指定时间范围内的所有聊天记录
   * @param startTime 开始时间（毫秒时间戳）
   * @param endTime 结束时间（毫秒时间戳）
   * @returns 所有会话的聊天记录列表
   */
  async getChatRecordsByTimeRange(
    startTime: number,
    endTime: number,
  ): Promise<
    Array<{
      chatId: string;
      messages: EnhancedMessageHistoryItem[];
    }>
  > {
    try {
      this.logger.log(
        `查询时间范围内的聊天记录: ${new Date(startTime).toISOString()} ~ ${new Date(endTime).toISOString()}`,
      );

      const records = await this.chatMessageRepository.getChatMessagesByTimeRange(
        startTime,
        endTime,
      );

      // 转换为 EnhancedMessageHistoryItem 格式
      const result = records.map(({ chatId, messages }) => ({
        chatId,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          chatId,
          messageId: m.messageId,
          candidateName: m.candidateName,
          managerName: m.managerName,
        })) as EnhancedMessageHistoryItem[],
      }));

      this.logger.log(
        `时间范围查询完成：找到 ${result.length} 个会话共 ${result.reduce((sum, r) => sum + r.messages.length, 0)} 条消息`,
      );

      return result;
    } catch (error) {
      this.logger.error('获取时间范围内的聊天记录失败:', error);
      return [];
    }
  }

  /**
   * 批量添加消息到历史记录
   * 用于高并发场景，减少数据库请求次数
   * v1.3: 新增 imBotId, imContactId, contactType, isSelf, payload, avatar, externalUserId 字段
   * @param messages 消息数组
   * @returns 成功保存的消息数量
   */
  async addMessagesToHistoryBatch(
    messages: Array<{
      chatId: string;
      role: 'user' | 'assistant';
      content: string;
      messageId?: string;
      candidateName?: string;
      managerName?: string;
      orgId?: string;
      botId?: string;
      messageType?: number;
      source?: number;
      isRoom?: boolean;
      // v1.3 新增字段
      imBotId?: string;
      imContactId?: string;
      contactType?: number;
      isSelf?: boolean;
      payload?: Record<string, unknown>;
      avatar?: string;
      externalUserId?: string;
    }>,
  ): Promise<number> {
    if (messages.length === 0) {
      return 0;
    }

    try {
      const messagesWithIds = messages.map((m) => ({
        chatId: m.chatId,
        messageId: m.messageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: m.role,
        content: m.content,
        timestamp: Date.now(),
        candidateName: m.candidateName,
        managerName: m.managerName,
        orgId: m.orgId,
        botId: m.botId,
        messageType: m.messageType,
        source: m.source,
        isRoom: m.isRoom,
        // v1.3 新增字段
        imBotId: m.imBotId,
        imContactId: m.imContactId,
        contactType: m.contactType,
        isSelf: m.isSelf,
        payload: m.payload,
        avatar: m.avatar,
        externalUserId: m.externalUserId,
      }));

      const savedCount = await this.chatMessageRepository.saveChatMessagesBatch(messagesWithIds);
      this.logger.debug(`批量添加 ${savedCount} 条消息到历史记录`);
      return savedCount;
    } catch (error) {
      this.logger.error('批量添加消息到历史失败:', error);
      return 0;
    }
  }
}
