import { useState, useMemo } from 'react';
import type { MessageRecord } from '@/api/types/chat.types';
import { renderContentWithMediaTags as renderMediaTags } from '@/utils/media-tags';
import { getHistoryMessages } from '../utils';
import styles from './index.module.scss';

interface HistorySectionProps {
  message: MessageRecord;
}

const renderContentWithMediaTags = (content: string) =>
  renderMediaTags(content, styles.mediaTag);

export default function HistorySection({ message }: HistorySectionProps) {
  const [expanded, setExpanded] = useState(true);

  const historyMessages = useMemo(() => getHistoryMessages(message), [message]);

  if (historyMessages.length === 0) {
    return null;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header} onClick={() => setExpanded(!expanded)}>
        <div className={styles.title}>
          <span>对话记录</span>
          <span className={styles.badge}>{historyMessages.length} 轮</span>
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
                  <span className={styles.roleBadge}>{msg.role === 'user' ? 'USER' : 'ASSISTANT'}</span>
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
