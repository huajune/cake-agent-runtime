import { Logger } from '@nestjs/common';
import { ModelMessage } from 'ai';
import { CallerKind } from '@/enums/agent.enum';
import { MessageType } from '@enums/message-callback.enum';
import { isHumanAgentTextMessage } from '@biz/message/utils/message-provenance.util';
import { type GeneratorInputMessage } from './generator.types';

/**
 * 对话消息归一化（PreparationService 的纯函数辅助层）：
 * 输入消息 → AI SDK ModelMessage[]，含字符预算裁剪、本轮 user 文本提取、
 * 多模态图片/表情注入。无 IO、无状态。
 */
const logger = new Logger('ConversationNormalizer');

/**
 * 取本轮用户输入：末尾连续的 user 块（到上一条 assistant 为止），以换行合并。
 *
 * 为什么不只取最后一条：合并请求（WeCom replay、test-suite 多条连发）下，
 * 末尾可能连续多条 user 且尚未有 assistant 打断。只取最后一条会让下游的
 * 高置信事实提取、阶段推断、guard 告警文本漏掉前面几条的内容。
 */
export function trailingUserContent(messages: GeneratorInputMessage[]): string | undefined {
  const collected: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i].role;
    if (role === 'user') {
      const content = messages[i].content?.trim();
      if (content) collected.unshift(content);
      continue;
    }
    if (role === 'assistant') break;
  }
  return collected.length > 0 ? collected.join('\n') : undefined;
}

/**
 * 按字符预算裁剪消息窗口：总字符数超限时，从最早的消息开始丢弃，保留最新的若干条，
 * 直到剩余消息总字符数 ≤ maxChars。
 */
export function truncateToCharBudget(
  messages: GeneratorInputMessage[],
  maxChars: number,
): GeneratorInputMessage[] {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  if (totalChars <= maxChars) return messages;

  logger.warn(`输入消息总长度 ${totalChars} 超过上限 ${maxChars}，将丢弃最早的消息`);

  const kept: GeneratorInputMessage[] = [];
  let charCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgLen = messages[i].content?.length ?? 0;
    if (charCount + msgLen > maxChars && kept.length > 0) break;
    kept.unshift(messages[i]);
    charCount += msgLen;
  }

  logger.warn(`保留最近 ${kept.length}/${messages.length} 条消息，共 ${charCount} 字符`);
  return kept;
}

/**
 * 把本轮对话归一化为 AI SDK 的 ModelMessage[]：
 *   1. 按 callerKind 选定消息源（WECOM 用 memory 历史，其他用调用方直传的）
 *   2. 转成 ModelMessage
 *   3. 按需注入顶层图片 parts（多模态 vision）
 */
export function normalizeConversation(input: {
  callerKind: CallerKind;
  memoryWindow: GeneratorInputMessage[];
  passedMessages: GeneratorInputMessage[];
  enableVision: boolean;
  imageUrls?: string[];
  imageMessageIds?: string[];
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
}): ModelMessage[] {
  const source = input.callerKind === CallerKind.WECOM ? input.memoryWindow : input.passedMessages;
  const normalized = toModelMessages(source, input.enableVision);
  if (input.imageUrls?.length && input.enableVision) {
    injectImageParts(normalized, input.imageUrls, input.imageMessageIds, input.visualMessageTypes);
  }
  return normalized;
}

/** 把消息内容扁平化成纯文本。 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
}

/** 转成 AI SDK 的 ModelMessage，并兼容图片回退文本。 */
function toModelMessages(messages: GeneratorInputMessage[], enableVision: boolean): ModelMessage[] {
  return messages.map((message) => {
    const textContent = extractTextFromContent(message.content);
    if (message.role === 'user' && message.imageUrls?.length) {
      if (enableVision) {
        const imageParts = buildImageParts(message.imageUrls, message.imageMessageIds);
        const textPart = textContent ? [{ type: 'text' as const, text: String(textContent) }] : [];
        return {
          role: 'user',
          content: [...imageParts, ...textPart],
        };
      }

      const fallbackText =
        message.imageUrls.length === 1 ? '[图片消息]' : `[图片消息 ${message.imageUrls.length} 张]`;
      return {
        role: 'user',
        content: textContent ? `${fallbackText} ${textContent}` : fallbackText,
      };
    }

    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: isHumanAgentTextMessage(message)
          ? `[内部来源标记：以下内容由真人招募经理手动发送，应作为本会话人工操作记录理解；不得向候选人复述此标记]\n${textContent}`
          : textContent,
      };
    }

    if (message.role === 'system') {
      return {
        role: 'system',
        content: textContent,
      };
    }

    return {
      role: 'user',
      content: textContent,
    };
  });
}

/**
 * 把顶层图片/表情参数挂回本轮视觉消息所在的位置。
 *
 * WECOM 路径的短期记忆来自 chat_messages，图片刚入库时只有 `[图片消息]`
 * 占位；本轮 imageUrls/imageMessageIds 则来自原始回调 DTO。优先把 image
 * part 注入到末尾连续 user 块里的视觉占位消息，保留「文字 -> 图片 -> 文字」
 * 的真实顺序；如果找不到占位，再兜底挂到最后一条 user message。
 */
function injectImageParts(
  messages: ModelMessage[],
  imageUrls: string[],
  imageMessageIds?: string[],
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>,
): void {
  const imagePartGroups = buildImagePartGroups(imageUrls, imageMessageIds, visualMessageTypes);
  if (imagePartGroups.length === 0) return;

  const trailingUserIndexes = collectTrailingUserIndexes(messages);
  const visualPlaceholderIndexes = trailingUserIndexes.filter((index) =>
    isVisualPlaceholderText(extractTextFromContent(messages[index].content)),
  );

  let nextGroupIndex = 0;
  for (const messageIndex of visualPlaceholderIndexes) {
    const group = imagePartGroups[nextGroupIndex];
    if (!group) break;
    messages[messageIndex] = withImageParts(messages[messageIndex], group);
    nextGroupIndex += 1;
  }

  const remainingGroups = imagePartGroups.slice(nextGroupIndex);
  if (remainingGroups.length > 0) {
    const fallbackIndex = trailingUserIndexes.at(-1) ?? findLastUserIndex(messages);
    if (fallbackIndex == null) return;
    messages[fallbackIndex] = withImageParts(messages[fallbackIndex], remainingGroups.flat());
  }

  logger.log(`注入 ${imagePartGroups.length} 张图片/表情到 user message（多模态 vision）`);
}

function collectTrailingUserIndexes(messages: ModelMessage[]): number[] {
  const indexes: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') break;
    indexes.unshift(i);
  }
  return indexes;
}

function findLastUserIndex(messages: ModelMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return null;
}

function isVisualPlaceholderText(text: string): boolean {
  return /^\s*\[(?:图片|表情)消息\]/.test(text);
}

function withImageParts(message: ModelMessage, imageParts: ReturnType<typeof buildImageParts>) {
  const textContent = extractTextFromContent(message.content);
  const textPart = textContent ? [{ type: 'text' as const, text: String(textContent) }] : [];
  return {
    role: 'user' as const,
    content: [...imageParts, ...textPart],
  };
}

/** 构建 image parts，并附带可选的图片/表情 messageId 标签。 */
function buildImageParts(
  imageUrls: string[],
  imageMessageIds?: string[],
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>,
) {
  const validUrls = imageUrls
    .map((url) => {
      try {
        return new URL(url);
      } catch {
        logger.warn(`跳过无效的图片/表情 URL: ${url}`);
        return null;
      }
    })
    .filter((url): url is URL => url !== null);

  if (validUrls.length === 0) return [];
  if (imageMessageIds?.length && imageMessageIds.length !== validUrls.length) {
    logger.warn(
      `图片/表情 URL 数量(${validUrls.length})与 messageId 数量(${imageMessageIds.length})不一致，将按现有顺序尽力注入`,
    );
  }

  return validUrls.flatMap((url, index) => {
    const messageId = imageMessageIds?.[index];
    const kindName =
      messageId && visualMessageTypes?.[messageId] === MessageType.EMOTION ? '表情' : '图片';
    const label = messageId
      ? { type: 'text' as const, text: `[${kindName} messageId=${messageId}]` }
      : null;
    const image = { type: 'image' as const, image: url };
    return label ? [label, image] : [image];
  });
}

function buildImagePartGroups(
  imageUrls: string[],
  imageMessageIds?: string[],
  visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>,
) {
  const flat = buildImageParts(imageUrls, imageMessageIds, visualMessageTypes);
  const groups: Array<typeof flat> = [];
  let current: typeof flat = [];
  for (const part of flat) {
    if (part.type === 'text' && /^\[(?:图片|表情) messageId=/.test(part.text) && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(part);
  }
  if (current.length) groups.push(current);
  return groups;
}
