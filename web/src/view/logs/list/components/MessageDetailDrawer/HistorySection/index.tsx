import { useState, useMemo } from 'react';
import type { MessageRecord } from '@/api/types/chat.types';
import styles from './index.module.scss';

// Agent API 消息结构
interface AgentMessagePart {
  type: string;
  text?: string;
}

interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  parts?: AgentMessagePart[];
}

// 简化的历史消息结构
interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface HistorySectionProps {
  message: MessageRecord;
}

/**
 * 从 Agent API 消息格式提取文本内容
 */
function extractTextFromParts(parts?: AgentMessagePart[]): string {
  if (!parts || parts.length === 0) return '';
  return parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n');
}

/**
 * 从 request.messages 中提取历史消息（排除当前用户消息）
 */
function extractHistoryMessages(messages: AgentMessage[] | undefined): HistoryMessage[] {
  if (!messages || messages.length === 0) return [];

  const history: HistoryMessage[] = [];

  // 遍历消息，排除最后一条用户消息（当前消息）
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // 跳过 system 消息
    if (msg.role === 'system') continue;

    // 最后一条用户消息是当前消息，不算历史
    const isLastUserMessage =
      msg.role === 'user' &&
      messages.slice(i + 1).every((m) => m.role !== 'user');

    if (isLastUserMessage) continue;

    const content = extractTextFromParts(msg.parts);
    if (content) {
      history.push({
        role: msg.role as 'user' | 'assistant',
        content,
      });
    }
  }

  return history;
}

// 媒体消息标记 → 样式映射
const MEDIA_TAG_MAP: Record<string, { icon: string; label: string }> = {
  '图片消息': { icon: '🖼️', label: '图片消息' },
  '语音消息': { icon: '🎤', label: '语音消息' },
  '表情': { icon: '😊', label: '表情' },
  '视频消息': { icon: '🎬', label: '视频消息' },
  '文件': { icon: '📎', label: '文件' },
  '链接': { icon: '🔗', label: '链接' },
  '小程序': { icon: '📱', label: '小程序' },
  '位置': { icon: '📍', label: '位置' },
  '名片': { icon: '👤', label: '名片' },
  '通话记录': { icon: '📞', label: '通话记录' },
  '红包/转账': { icon: '🧧', label: '红包/转账' },
  '已撤回': { icon: '↩️', label: '已撤回' },
};

/**
 * 将文本中的 [图片消息] 等标记渲染为带图标的标签
 */
function renderContentWithMediaTags(content: string) {
  const regex = /\[([^\]]+)\]/g;
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const tag = MEDIA_TAG_MAP[match[1]];
    if (tag) {
      if (match.index > lastIndex) {
        parts.push(content.slice(lastIndex, match.index));
      }
      parts.push(
        <span key={match.index} className={styles.mediaTag}>
          {tag.icon} {tag.label}
        </span>,
      );
      lastIndex = match.index + match[0].length;
    }
  }

  if (lastIndex === 0) return content;
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }
  return <>{parts}</>;
}

export default function HistorySection({ message }: HistorySectionProps) {
  const [expanded, setExpanded] = useState(true);

  // 从 agentInvocation.request.messages 中提取历史消息
  const historyMessages = useMemo(() => {
    const request = message.agentInvocation?.request as {
      messages?: AgentMessage[];
    } | undefined;
    return extractHistoryMessages(request?.messages);
  }, [message.agentInvocation?.request]);

  // 如果没有历史消息，不显示此区域
  if (historyMessages.length === 0) {
    return null;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header} onClick={() => setExpanded(!expanded)}>
        <div className={styles.title}>
          <span>💬</span>
          <span>历史对话</span>
          <span className={styles.badge}>{historyMessages.length} 条</span>
        </div>
        <span className={`${styles.toggleIcon} ${expanded ? styles.expanded : ''}`}>
          ▼
        </span>
      </div>

      {expanded && (
        <div className={styles.content}>
          {historyMessages.length === 0 ? (
            <div className={styles.emptyState}>暂无历史消息</div>
          ) : (
            <div className={styles.messageList}>
              {historyMessages.map((msg, index) => (
                <div
                  key={index}
                  className={`${styles.messageItem} ${styles[msg.role]}`}
                >
                  <span className={styles.roleIcon}>
                    {msg.role === 'user' ? '👤' : '🤖'}
                  </span>
                  <div className={styles.messageContent}>
                    {renderContentWithMediaTags(msg.content)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
