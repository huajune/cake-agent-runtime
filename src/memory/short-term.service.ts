import { Injectable, Logger } from '@nestjs/common';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MessageParser } from '@channels/wecom/message/utils/message-parser.util';
import { MemoryConfig } from './memory.config';

/**
 * 短期记忆服务 — 对话窗口管理
 *
 * 从 chat_messages（Supabase 永久存储）中读取最近 N 条消息，
 * 按窗口策略（条数 + 时间 + 字符上限）裁剪后输出给 Agent。
 *
 * 统一了原先分散在 MessageHistoryService.getHistory() + LoopService.trimMessages() 中的逻辑。
 */
@Injectable()
export class ShortTermService {
  private readonly logger = new Logger(ShortTermService.name);

  constructor(
    private readonly chatSession: ChatSessionService,
    private readonly config: MemoryConfig,
  ) {}

  /**
   * 获取会话的短期记忆（裁剪后的消息窗口）
   *
   * 1. 从 chat_messages 取最近 N 条 + 时间窗口内
   * 2. 注入时间上下文
   * 3. 按字符上限裁剪
   */
  async getMessages(chatId: string): Promise<{ role: string; content: string }[]> {
    try {
      const rawHistory = await this.chatSession.getChatHistory(
        chatId,
        this.config.shortTermMaxMessages,
      );

      // 注入时间上下文
      const messages = rawHistory.map((msg) => ({
        role: msg.role,
        content: MessageParser.injectTimeContext(msg.content, msg.timestamp),
      }));

      // 字符上限裁剪
      return this.trimByChars(messages);
    } catch (error) {
      this.logger.error(`获取短期记忆失败 [${chatId}]:`, error);
      return [];
    }
  }

  /**
   * 字符上限裁剪 — 从最早的消息开始丢弃，保留最新的
   */
  private trimByChars(
    messages: { role: string; content: string }[],
  ): { role: string; content: string }[] {
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    if (totalChars <= this.config.shortTermMaxChars) return messages;

    this.logger.warn(
      `短期记忆总长度 ${totalChars} 超过上限 ${this.config.shortTermMaxChars}，将丢弃最早的消息`,
    );

    const kept: { role: string; content: string }[] = [];
    let charCount = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msgLen = messages[i].content?.length ?? 0;
      if (charCount + msgLen > this.config.shortTermMaxChars && kept.length > 0) break;
      kept.unshift(messages[i]);
      charCount += msgLen;
    }

    this.logger.warn(`保留最近 ${kept.length}/${messages.length} 条消息，共 ${charCount} 字符`);
    return kept;
  }
}
