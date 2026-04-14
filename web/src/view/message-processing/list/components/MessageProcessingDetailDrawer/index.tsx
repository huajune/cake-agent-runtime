import { useEffect, useMemo, useRef } from 'react';
import { formatDuration } from '@/utils/format';
import { useMessageProcessingRecordDetail } from '@/hooks/chat/useMessageProcessingRecords';
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
  const leftColRef = useRef<HTMLDivElement | null>(null);
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

  useEffect(() => {
    if (!isLoading) {
      leftColRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [messageId, isLoading]);

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
    {
      label: 'LLM',
      value:
        (timings.llmMs ?? message.aiDuration) !== undefined
          ? formatDuration((timings.llmMs ?? message.aiDuration)!)
          : '-',
    },
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

        {/* Body — left/right split */}
        <div className={styles.body}>
          <div ref={leftColRef} className={styles.leftCol}>
            <ChatSection message={message} />
          </div>

          <div className={styles.rightCol}>
            {/* Metrics */}
            <div className={styles.sideTitle}>执行指标</div>
            <div className={styles.metricsGrid}>
              {headlineMetrics.map((m) => (
                <div key={m.label} className={styles.metricCard}>
                  <div className={styles.metricLabel}>{m.label}</div>
                  <div className={styles.metricValue}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Latency breakdown */}
            {latencyRows.length > 0 && (
              <>
                <div className={styles.sideTitle}>时延分解</div>
                <div className={styles.latencyList}>
                  {latencyRows.map((r) => (
                    <div key={r.label} className={styles.latencyRow}>
                      <span className={styles.latencyLabel}>{r.label}</span>
                      <span className={styles.latencyValue}>{formatDuration(r.value)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* Execution facts */}
            {executionFacts.length > 0 && (
              <>
                <div className={styles.sideTitle}>执行摘要</div>
                <div className={styles.latencyList}>
                  {executionFacts.map((f) => (
                    <div key={f.label} className={styles.latencyRow}>
                      <span className={styles.latencyLabel}>{f.label}</span>
                      <span className={styles.latencyValue}>{f.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
