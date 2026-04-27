import { useCallback, useEffect, useMemo, useRef } from 'react';
import { formatDuration } from '@/utils/format';
import { FeedbackButtons } from '@/view/agent-test/list/components/FeedbackButtons';
import { FeedbackModal } from '@/view/agent-test/list/components/FeedbackModal';
import { useFeedback } from '@/view/agent-test/list/hooks/useFeedback';
import { useMessageProcessingRecordDetail } from '@/hooks/chat/useMessageProcessingRecords';
import ChatSection from './ChatSection';
import {
  getStatusLabel,
  getStatusTone,
  getTimingMetrics,
  getExecutionFacts,
  getContextFacts,
  getHistoryMessages,
} from './utils';
import styles from './index.module.scss';

interface MessageProcessingDetailDrawerProps {
  messageId: string;
  onClose: () => void;
}

function withFallback<T>(factory: () => T, fallback: T): T {
  try {
    return factory();
  } catch (error) {
    console.warn('[MessageProcessingDetailDrawer] derived data fallback', error);
    return fallback;
  }
}

export default function MessageProcessingDetailDrawer({
  messageId,
  onClose,
}: MessageProcessingDetailDrawerProps) {
  const { data: message, isLoading } = useMessageProcessingRecordDetail(messageId);
  const leftColRef = useRef<HTMLDivElement | null>(null);
  const feedback = useFeedback();
  const {
    clearSuccess,
    closeModal,
    feedbackType,
    isOpen,
    isSubmitting,
    openModal,
    remark,
    scenarioType,
    setRemark,
    setScenarioType,
    submit,
    submitError,
    successType,
  } = feedback;
  const timings = useMemo(
    () => (message ? withFallback(() => getTimingMetrics(message), {}) : {}),
    [message],
  );
  const executionFacts = useMemo(
    () => (message ? withFallback(() => getExecutionFacts(message), []) : []),
    [message],
  );
  const contextFacts = useMemo(
    () => (message ? withFallback(() => getContextFacts(message), []) : []),
    [message],
  );
  const feedbackHistoryMessages = useMemo(
    () => {
      if (!message) return [];

      const fallback: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (message.messagePreview?.trim()) {
        fallback.push({ role: 'user', content: message.messagePreview });
      }
      if (message.replyPreview?.trim()) {
        fallback.push({ role: 'assistant', content: message.replyPreview });
      }

      return withFallback(() => getHistoryMessages(message), fallback);
    },
    [message],
  );
  const chatHistoryPreview = useMemo(() => {
    if (!message) return '';

    return feedbackHistoryMessages
      .map((item, index) => {
        const displayName =
          item.role === 'assistant'
            ? message.managerName || '招募经理'
            : message.userName || '候选人';
        return `[${index + 1} ${displayName}] ${item.content}`;
      })
      .join('\n');
  }, [feedbackHistoryMessages, message]);
  const lastUserMessage = useMemo(
    () =>
      [...feedbackHistoryMessages]
        .reverse()
        .find((item) => item.role === 'user' && item.content.trim())?.content ||
      message?.messagePreview,
    [feedbackHistoryMessages, message?.messagePreview],
  );
  const latencyRows = useMemo(
    () =>
      [
        { label: 'Quiet Window', value: timings.quietWindowWaitMs },
        { label: 'PreDispatch', value: timings.preDispatchMs },
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

  const handleSubmitFeedback = useCallback(() => {
    if (!message) return;

    void submit({
      chatHistory: chatHistoryPreview,
      userMessage: lastUserMessage,
      chatId: message.chatId,
      batchId: message.batchId,
      candidateName: message.userName,
      managerName: message.managerName,
    });
  }, [chatHistoryPreview, lastUserMessage, message, submit]);

  useEffect(() => {
    if (!isLoading) {
      leftColRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [messageId, isLoading]);

  useEffect(() => {
    clearSuccess();
  }, [clearSuccess, messageId]);

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
    message.tokenUsage != null && message.tokenUsage !== 0
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

            {/* Context facts */}
            {contextFacts.length > 0 && (
              <>
                <div className={styles.sideTitle}>排障上下文</div>
                <div className={styles.latencyList}>
                  {contextFacts.map((f) => (
                    <div key={f.label} className={styles.latencyRow}>
                      <span className={styles.latencyLabel}>{f.label}</span>
                      <span
                        className={`${styles.latencyValue} ${f.mono ? styles.monoValue : ''}`}
                      >
                        {f.value}
                      </span>
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

        <div className={styles.actionBar}>
          <div className={styles.feedbackGroup}>
            <FeedbackButtons
              successType={successType}
              disabled={isLoading || !chatHistoryPreview.trim()}
              onGoodCase={() => openModal('goodcase')}
              onBadCase={() => openModal('badcase')}
            />
          </div>
        </div>

        <FeedbackModal
          isOpen={isOpen}
          feedbackType={feedbackType}
          scenarioType={scenarioType}
          remark={remark}
          isSubmitting={isSubmitting}
          chatHistoryPreview={chatHistoryPreview}
          submitError={submitError}
          onClose={closeModal}
          onScenarioTypeChange={setScenarioType}
          onRemarkChange={setRemark}
          onSubmit={handleSubmitFeedback}
        />
      </div>
    </div>
  );
}
