import { Injectable, Logger } from '@nestjs/common';
import {
  ParsedMessage,
  ConversationTurn,
  ConversationParseResult,
} from '../../dto/conversation-test.dto';
import type { AgentResult } from '@agent';

/**
 * 对话解析正则表达式
 * 匹配格式: [MM/DD HH:mm 角色] 消息内容
 * 例如: [12/04 17:20 候选人] 这还招人吗
 */
const CONVERSATION_LINE_PATTERN = /^\[(\d{2}\/\d{2}\s+\d{2}:\d{2})\s+(候选人|招募经理)\]\s*(.+)$/;

/**
 * 对话文本解析服务
 *
 * 职责：
 * - 解析原始对话文本为结构化消息
 * - 将对话拆解为测试轮次
 * - 从 Agent 响应中提取文本和工具调用
 */
@Injectable()
export class ConversationParserService {
  private readonly logger = new Logger(ConversationParserService.name);

  /**
   * 解析原始对话文本
   *
   * @param rawText 原始对话文本（带时间戳）
   * @returns 解析结果
   */
  parseConversation(rawText: string): ConversationParseResult {
    if (!rawText || !rawText.trim()) {
      return {
        success: false,
        messages: [],
        totalTurns: 0,
        error: '对话内容为空',
      };
    }

    try {
      const lines = rawText.split('\n').filter((line) => line.trim());
      const messages: ParsedMessage[] = [];
      let currentMessage: ParsedMessage | null = null;

      for (const line of lines) {
        const match = line.match(CONVERSATION_LINE_PATTERN);

        if (match) {
          // 如果有未保存的消息，先保存
          if (currentMessage) {
            messages.push(currentMessage);
          }

          const [, timestamp, role, content] = match;
          const mappedRole: 'user' | 'assistant' = role === '候选人' ? 'user' : 'assistant';

          currentMessage = {
            role: mappedRole,
            content: content.trim(),
            timestamp,
          };
        } else if (currentMessage && line.trim()) {
          // 连续行，追加到当前消息
          currentMessage.content += '\n' + line.trim();
        }
      }

      // 保存最后一条消息
      if (currentMessage) {
        messages.push(currentMessage);
      }

      // 合并连续的同角色消息
      const mergedMessages = this.mergeConsecutiveMessages(messages);

      // 计算轮数（候选人发言次数）
      const totalTurns = mergedMessages.filter((m) => m.role === 'user').length;

      return {
        success: true,
        messages: mergedMessages,
        totalTurns,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`对话解析失败: ${errorMsg}`);
      return {
        success: false,
        messages: [],
        totalTurns: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * 将对话拆解为多个测试轮次
   *
   * @param messages 解析后的消息列表
   * @returns 测试轮次数组
   */
  splitIntoTurns(messages: ParsedMessage[]): ConversationTurn[] {
    const turns: ConversationTurn[] = [];
    let turnNumber = 0;

    for (let i = 0; i < messages.length; i++) {
      const current = messages[i];

      // 只在用户消息时创建测试轮次
      if (current.role === 'user') {
        turnNumber++;

        // 查找该用户消息之后的助手回复
        const nextAssistant = messages[i + 1];
        const expectedOutput = nextAssistant?.role === 'assistant' ? nextAssistant.content : '';

        // 构建历史上下文（当前轮之前的所有消息）
        const history = messages.slice(0, i);

        turns.push({
          turnNumber,
          history,
          userMessage: current.content,
          expectedOutput,
        });
      }
    }

    return turns;
  }

  /**
   * 提取响应文本
   */
  extractResponseText(result: AgentResult): string {
    try {
      const response = result.data || result.fallback;
      if (!response?.messages?.length) return '';

      return response.messages
        .map((msg) => {
          if (msg.parts) {
            return msg.parts.map((p) => p.text || '').join('');
          }
          return '';
        })
        .join('\n\n');
    } catch {
      return '';
    }
  }

  /**
   * 提取工具调用
   * 使用两遍扫描配对 tool_call/tool_use 和 tool_result
   */
  extractToolCalls(result: AgentResult): unknown[] {
    try {
      const response = result.data || result.fallback;
      if (!response?.messages?.length) return [];

      // 第一遍: 收集所有 tool_call/tool_use
      const toolCallMap = new Map<string, { toolName: string; input: unknown; output?: unknown }>();

      for (const msg of response.messages) {
        if (!msg.parts) continue;

        for (const part of msg.parts) {
          const partAny = part as unknown as Record<string, unknown>;

          // 提取 tool_call/tool_use
          if (partAny.type === 'tool_call' || partAny.type === 'tool_use') {
            const toolCallId = (partAny.toolCallId || partAny.id) as string;
            const toolName = (partAny.toolName || partAny.name) as string;
            const input = partAny.input || partAny.args;

            if (toolCallId && toolName) {
              toolCallMap.set(toolCallId, { toolName, input });
            }
          }
        }
      }

      // 第二遍: 匹配 tool_result
      for (const msg of response.messages) {
        if (!msg.parts) continue;

        for (const part of msg.parts) {
          const partAny = part as unknown as Record<string, unknown>;

          // 提取 tool_result
          if (partAny.type === 'tool_result') {
            const toolCallId = partAny.toolCallId as string;
            const output = partAny.result || partAny.output;

            if (toolCallId && toolCallMap.has(toolCallId)) {
              const toolCall = toolCallMap.get(toolCallId)!;
              toolCall.output = output;
            }
          }
        }
      }

      // 转换为数组格式
      return Array.from(toolCallMap.values());
    } catch {
      return [];
    }
  }

  /**
   * 合并连续的同角色消息
   */
  private mergeConsecutiveMessages(messages: ParsedMessage[]): ParsedMessage[] {
    if (messages.length === 0) return [];

    const merged: ParsedMessage[] = [];
    let current = { ...messages[0] };

    for (let i = 1; i < messages.length; i++) {
      if (messages[i].role === current.role) {
        // 同角色消息，合并内容
        current.content += '\n' + messages[i].content;
      } else {
        // 不同角色，保存当前消息并开始新消息
        merged.push(current);
        current = { ...messages[i] };
      }
    }

    merged.push(current);
    return merged;
  }
}
