import { formatDateTime } from '@/utils/format';
import { useMessageProcessingRecordDetail } from '@/hooks/chat/useMessageProcessingRecords';
import HistorySection from './HistorySection';
import ChatSection from './ChatSection';
import TechnicalStats from './TechnicalStats';
import { getStatusLabel, getStatusTone } from './utils';
import styles from './index.module.scss';

interface MessageProcessingDetailDrawerProps {
  messageId: string;
  onClose: () => void;
}

export default function MessageProcessingDetailDrawer({
  messageId,
  onClose,
}: MessageProcessingDetailDrawerProps) {
  const { data: message, isLoading } = useMessageProcessingRecordDetail(messageId);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (isLoading || !message) {
    return (
      <div className="drawer-overlay" onClick={handleOverlayClick}>
        <div className="drawer-content">
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h3 className={styles.headerTitle}>处理记录详情</h3>
            </div>
            <button className={styles.closeBtn} onClick={onClose}>&times;</button>
          </div>
          <div className={styles.loadingBody}>
            {isLoading ? '加载中...' : '未找到消息详情'}
          </div>
        </div>
      </div>
    );
  }

  const statusTone = getStatusTone(message.status);

  const metaTags = [
    { label: '接收', value: formatDateTime(message.receivedAt) },
    { label: '主体', value: message.userName || message.chatId },
    ...(message.scenario ? [{ label: '场景', value: message.scenario }] : []),
  ];

  return (
    <div className="drawer-overlay" onClick={handleOverlayClick}>
      <div className="drawer-content">
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h3 className={styles.headerTitle}>处理记录详情</h3>
            <span className={`status-badge ${statusTone}`}>
              {getStatusLabel(message.status)}
            </span>
            {message.isFallback && (
              <span className="status-badge warning">
                {message.fallbackSuccess ? 'Fallback 成功' : 'Fallback 失败'}
              </span>
            )}
          </div>

          <div className={styles.headerMeta}>
            {metaTags.map((tag) => (
              <span key={tag.label} className={styles.metaTag}>
                <span className={styles.metaTagLabel}>{tag.label}</span>
                {tag.value}
              </span>
            ))}
          </div>

          <button className={styles.closeBtn} onClick={onClose}>&times;</button>
        </div>

        {/* Body */}
        <div className={styles.body}>
          <div className={styles.leftCol}>
            <HistorySection message={message} />
            <ChatSection message={message} />
          </div>

          <div className={styles.rightCol}>
            <TechnicalStats message={message} />
          </div>
        </div>
      </div>
    </div>
  );
}
