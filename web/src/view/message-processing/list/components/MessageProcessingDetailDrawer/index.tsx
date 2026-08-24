import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDuration, formatLocaleNumber } from '@/utils/format';
import { FeedbackButtons } from '@/view/agent-test/list/components/FeedbackButtons';
import { FeedbackModal } from '@/view/agent-test/list/components/FeedbackModal';
import { useFeedback } from '@/view/agent-test/list/hooks/useFeedback';
import { useMessageProcessingRecordDetail } from '@/hooks/chat/useMessageProcessingRecords';
import type { FeedbackSourceTrace } from '@/api/types/agent-test.types';
import ChatSection from './ChatSection';
import ExecutionEventTimeline from './ExecutionEventTimeline';
import GuardrailSection from './GuardrailSection';
import {
  getRecordStatusLabel,
  getRecordStatusTone,
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

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const POST_PROCESSING_STATUS_LABELS = {
  running: '运行中',
  completed: '已完成',
  completed_with_errors: '部分失败',
  skipped: '已跳过',
  interrupted: '已中断',
} as const;

const POST_PROCESSING_STEP_LABELS = {
  success: '成功',
  failure: '失败',
  skipped: '跳过',
} as const;

export default function MessageProcessingDetailDrawer({
  messageId,
  onClose,
}: MessageProcessingDetailDrawerProps) {
  const navigate = useNavigate();
  const { data: message, isLoading } = useMessageProcessingRecordDetail(messageId);
  const leftColRef = useRef<HTMLDivElement | null>(null);
  const [traceCopied, setTraceCopied] = useState(false);
  const feedback = useFeedback();
  const {
    clearSuccess,
    closeModal,
    feedbackType,
    isOpen,
    isSubmitting,
    openModal,
    remark,
    priority,
    expectedBehavior,
    scenarioType,
    setRemark,
    setPriority,
    setExpectedBehavior,
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
  const feedbackHistoryMessages = useMemo(() => {
    if (!message) return [];

    const fallback: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (message.messagePreview?.trim()) {
      fallback.push({ role: 'user', content: message.messagePreview });
    }
    if (message.replyPreview?.trim()) {
      fallback.push({ role: 'assistant', content: message.replyPreview });
    }

    return withFallback(() => getHistoryMessages(message), fallback);
  }, [message]);
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
  const feedbackTrace = useMemo<{
    traceId?: string;
    sourceTrace?: FeedbackSourceTrace;
  }>(() => {
    if (!message) return {};

    const response = message.agentInvocation?.response;
    const traceId = asString(response?.traceId);
    return {
      traceId,
      sourceTrace: {
        chatIds: message.chatId ? [message.chatId] : undefined,
        anchorMessageIds: message.messageId ? [message.messageId] : undefined,
        relatedMessageIds: message.messageId ? [message.messageId] : undefined,
        messageProcessingIds: message.messageId ? [message.messageId] : undefined,
        traceIds: traceId ? [traceId] : undefined,
        batchIds: message.batchId ? [message.batchId] : undefined,
        raw: {
          source: 'message-processing-detail-drawer',
          status: message.status,
          scenario: message.scenario,
          anomalyFlags: message.anomalyFlags,
          memorySnapshot: message.memorySnapshot,
          postProcessingStatus: message.postProcessingStatus,
          toolCalls: message.toolCalls,
          agentSteps: message.agentSteps?.map((step) => ({
            stepIndex: step.stepIndex,
            toolCalls: step.toolCalls?.map((toolCall) => toolCall.toolName),
            usage: step.usage,
            durationMs: step.durationMs,
            finishReason: step.finishReason,
          })),
        },
      },
    };
  }, [message]);
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
      messageId: message.messageId,
      traceId: feedbackTrace.traceId,
      batchId: message.batchId,
      sourceTrace: feedbackTrace.sourceTrace,
      candidateName: message.userName,
      managerName: message.managerName,
    });
  }, [chatHistoryPreview, feedbackTrace, lastUserMessage, message, submit]);

  useEffect(() => {
    if (!isLoading) {
      leftColRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [messageId, isLoading]);

  useEffect(() => {
    clearSuccess();
    setTraceCopied(false);
  }, [clearSuccess, messageId]);

  if (isLoading || !message) {
    return (
      <div className="drawer-overlay" onClick={handleOverlayClick}>
        <div className="drawer-content">
          <div className={styles.header}>
            <div className={styles.headerTop}>
              <h3 className={styles.headerTitle}>处理记录详情</h3>
              <button className={styles.closeBtn} onClick={onClose}>
                &times;
              </button>
            </div>
          </div>
          <div className={styles.loadingBody}>{isLoading ? '加载中...' : '未找到消息详情'}</div>
        </div>
      </div>
    );
  }

  const statusTone = getRecordStatusTone(message);
  const traceId = message.messageId ?? messageId;
  const handleCopyTraceId = async () => {
    await navigator.clipboard.writeText(traceId);
    setTraceCopied(true);
  };

  const tokenValue =
    message.tokenUsage != null && message.tokenUsage !== 0
      ? formatLocaleNumber(message.tokenUsage)
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
            <button
              type="button"
              className={styles.conversationLink}
              onClick={() => navigate(`/chat-records?chatId=${encodeURIComponent(message.chatId)}`)}
            >
              查看会话
            </button>
            <span className={`status-badge ${statusTone}`} title={message.error}>
              {getRecordStatusLabel(message)}
            </span>
            {message.isFallback && (
              <span className="status-badge warning">
                {message.fallbackSuccess ? 'Fallback 成功' : 'Fallback 失败'}
              </span>
            )}
            <button className={styles.closeBtn} onClick={onClose}>
              &times;
            </button>
          </div>
        </div>

        {/* Body — left/right split */}
        <div className={styles.body}>
          <div ref={leftColRef} className={styles.leftCol}>
            <ChatSection message={message} />
            <ExecutionEventTimeline events={message.executionEvents ?? []} />
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

            {/* Guardrail runtime（入站拦截 / 出站首审→修复→二审） */}
            <GuardrailSection message={message} />

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
            <div className={styles.sideTitle}>排障上下文</div>
            <div className={styles.latencyList}>
              <div className={styles.latencyRow}>
                <span className={styles.latencyLabel}>Trace ID</span>
                <span className={styles.traceValue}>
                  <code title={traceId}>{traceId}</code>
                  <button type="button" onClick={() => void handleCopyTraceId()}>
                    {traceCopied ? '已复制' : '复制'}
                  </button>
                </span>
              </div>
              {message.alertType && (
                <div className={styles.latencyRow}>
                  <span className={styles.latencyLabel}>Alert Type</span>
                  <code className={`${styles.latencyValue} ${styles.monoValue}`}>
                    {message.alertType}
                  </code>
                </div>
              )}
              {message.botImId && (
                <div className={styles.latencyRow}>
                  <span className={styles.latencyLabel}>Bot IM ID</span>
                  <code className={`${styles.latencyValue} ${styles.monoValue}`}>
                    {message.botImId}
                  </code>
                </div>
              )}
              {contextFacts.map((f) => (
                <div key={f.label} className={styles.latencyRow}>
                  <span className={styles.latencyLabel}>{f.label}</span>
                  <span className={`${styles.latencyValue} ${f.mono ? styles.monoValue : ''}`}>
                    {f.value}
                  </span>
                </div>
              ))}
            </div>

            {message.anomalyFlags && message.anomalyFlags.length > 0 && (
              <>
                <div className={styles.sideTitle}>异常信号</div>
                <div className={styles.anomalyFlags}>
                  {message.anomalyFlags.map((flag) => (
                    <code key={flag} className={styles.anomalyFlag}>
                      {flag}
                    </code>
                  ))}
                </div>
              </>
            )}

            {message.postProcessingStatus && (
              <>
                <div className={styles.sideTitle}>后处理状态</div>
                <div className={styles.postProcessingPanel}>
                  <div className={styles.postProcessingSummary}>
                    <span
                      className={`${styles.postStatus} ${
                        message.postProcessingStatus.status === 'completed'
                          ? styles.postStatusSuccess
                          : message.postProcessingStatus.status === 'completed_with_errors' ||
                              message.postProcessingStatus.status === 'interrupted'
                            ? styles.postStatusError
                            : styles.postStatusNeutral
                      }`}
                    >
                      {POST_PROCESSING_STATUS_LABELS[message.postProcessingStatus.status]}
                    </span>
                    <span>
                      {message.postProcessingStatus.counts.succeeded}/
                      {message.postProcessingStatus.counts.total} 成功
                    </span>
                    {message.postProcessingStatus.durationMs !== undefined && (
                      <span>{formatDuration(message.postProcessingStatus.durationMs)}</span>
                    )}
                  </div>
                  {message.postProcessingStatus.steps.map((step, index) => (
                    <div key={`${step.name}-${index}`} className={styles.postProcessingStep}>
                      <div className={styles.postStepHeader}>
                        <code>{step.name}</code>
                        <span className={styles[`postStep${step.status}`]}>
                          {POST_PROCESSING_STEP_LABELS[step.status]}
                        </span>
                        <span>{formatDuration(step.durationMs)}</span>
                      </div>
                      {(step.error || step.reason) && (
                        <div className={styles.postStepMessage}>{step.error || step.reason}</div>
                      )}
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
          priority={priority}
          expectedBehavior={expectedBehavior}
          isSubmitting={isSubmitting}
          chatHistoryPreview={chatHistoryPreview}
          submitError={submitError}
          onClose={closeModal}
          onScenarioTypeChange={setScenarioType}
          onRemarkChange={setRemark}
          onPriorityChange={setPriority}
          onExpectedBehaviorChange={setExpectedBehavior}
          onSubmit={handleSubmitFeedback}
        />
      </div>
    </div>
  );
}
