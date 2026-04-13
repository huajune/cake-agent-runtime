import { useMemo } from 'react';
import { formatDuration } from '@/utils/format';
import { useMessageProcessingRecordDetail } from '@/hooks/chat/useMessageProcessingRecords';
import HistorySection from './HistorySection';
import ChatSection from './ChatSection';
import { getStatusLabel, getStatusTone, getTimingMetrics, getExecutionFacts } from './utils';
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
  const timings = useMemo(() => (message ? getTimingMetrics(message) : {}), [message]);
  const executionFacts = useMemo(() => (message ? getExecutionFacts(message) : []), [message]);
  const latencyRows = useMemo(
    () =>
      [
        { label: 'Queue', value: timings.queueWaitMs },
        { label: 'Preparation', value: timings.prepMs },
        { label: 'LLM', value: timings.llmMs ?? message?.aiDuration },
        { label: 'Delivery', value: timings.deliveryMs ?? message?.sendDuration },
      ].filter((item): item is { label: string; value: number } => item.value !== undefined),
    [timings, message],
  );

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
            <div className={styles.headerTop}>
              <h3 className={styles.headerTitle}>处理记录详情</h3>
              <button className={styles.closeBtn} onClick={onClose}>&times;</button>
            </div>
          </div>
          <div className={styles.loadingBody}>
            {isLoading ? '加载中...' : '未找到消息详情'}
          </div>
        </div>
      </div>
    );
  }

  const statusTone = getStatusTone(message.status);

  const tokenValue =
    message.tokenUsage !== undefined && message.tokenUsage !== 0
      ? message.tokenUsage.toLocaleString()
      : '-';

  const headlineMetrics = [
    { label: 'E2E', value: timings.e2eMs !== undefined ? formatDuration(timings.e2eMs) : '-' },
    { label: 'TTFT', value: timings.ttftMs !== undefined ? formatDuration(timings.ttftMs) : '-' },
    { label: 'LLM', value: (timings.llmMs ?? message.aiDuration) !== undefined ? formatDuration((timings.llmMs ?? message.aiDuration)!) : '-' },
    { label: 'Token', value: tokenValue },
  ];

  return (
    <div className="drawer-overlay" onClick={handleOverlayClick}>
      <div className="drawer-content">
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerTop}>
            <h3 className={styles.headerTitle}>处理记录详情</h3>
            <span className={`status-badge ${statusTone}`}>
              {getStatusLabel(message.status)}
            </span>
            {message.isFallback && (
              <span className="status-badge warning">
                {message.fallbackSuccess ? 'Fallback 成功' : 'Fallback 失败'}
              </span>
            )}
            <button className={styles.closeBtn} onClick={onClose}>&times;</button>
          </div>

        </div>

        {/* Metrics strip */}
        <div className={styles.metricsStrip}>
          {headlineMetrics.map((m) => (
            <div key={m.label} className={styles.metricItem}>
              <div className={styles.metricLabel}>{m.label}</div>
              <div className={styles.metricValue}>{m.value}</div>
            </div>
          ))}
        </div>

        {/* Execution facts as pills */}
        {executionFacts.length > 0 && (
          <div className={styles.factsPills}>
            {executionFacts.map((f) => (
              <span key={f.label} className={styles.factPill}>
                {f.label}: {f.value}
              </span>
            ))}
          </div>
        )}

        {/* Body — left/right split */}
        <div className={styles.body}>
          <div className={styles.leftCol}>
            <HistorySection message={message} />
            <ChatSection message={message} />
          </div>
          {latencyRows.length > 0 && (
            <div className={styles.rightCol}>
              <div className={styles.sideTitle}>时延分解</div>
              <div className={styles.latencyList}>
                {latencyRows.map((r) => (
                  <div key={r.label} className={styles.latencyRow}>
                    <span className={styles.latencyLabel}>{r.label}</span>
                    <span className={styles.latencyValue}>{formatDuration(r.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
