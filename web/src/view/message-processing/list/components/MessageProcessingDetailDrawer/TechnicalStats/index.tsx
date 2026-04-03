import { useMemo } from 'react';
import { formatDuration } from '@/utils/format';
import type { MessageRecord } from '@/api/types/chat.types';
import {
  getChunkSummary,
  getContextFacts,
  getExecutionFacts,
  getTimingMetrics,
  getToolCalls,
} from '../utils';
import styles from './index.module.scss';

interface TechnicalStatsProps {
  message: MessageRecord;
}

export default function TechnicalStats({ message }: TechnicalStatsProps) {
  const timings = useMemo(() => getTimingMetrics(message), [message]);
  const executionFacts = useMemo(() => getExecutionFacts(message), [message]);
  const contextFacts = useMemo(() => getContextFacts(message), [message]);
  const toolCalls = useMemo(() => getToolCalls(message), [message]);
  const chunkSummary = useMemo(() => getChunkSummary(message), [message]);
  const identityFacts = useMemo(
    () => contextFacts.filter((item) => item.mono),
    [contextFacts],
  );
  const profileFacts = useMemo(
    () => contextFacts.filter((item) => !item.mono),
    [contextFacts],
  );

  const tokenValue = message.tokenUsage?.toLocaleString() || '-';
  const formatMetricDuration = (value?: number) =>
    value === undefined ? '-' : formatDuration(value);

  const headlineMetrics: Array<{
    label: string;
    value: string;
    tone: 'primary' | 'warning';
  }> = [
    { label: 'E2E', value: formatMetricDuration(timings.e2eMs ?? message.totalDuration), tone: 'primary' },
    { label: 'LLM', value: formatMetricDuration(timings.llmMs ?? message.aiDuration), tone: 'primary' },
    { label: 'TTFT', value: formatMetricDuration(timings.ttftMs), tone: 'warning' },
    { label: 'Token', value: tokenValue, tone: 'warning' },
  ];

  const latencyRows = [
    { label: 'Queue Wait', value: timings.queueWaitMs },
    { label: 'Preparation', value: timings.prepMs },
    { label: 'LLM Runtime', value: timings.llmMs ?? message.aiDuration },
    { label: 'TTFT', value: timings.ttftMs },
    { label: 'TTFR', value: timings.ttfrMs },
    { label: 'First Chunk', value: timings.firstChunkMs },
    { label: 'Delivery', value: timings.deliveryMs ?? message.sendDuration },
  ].filter((item) => item.value !== undefined);

  return (
    <>
      <h4 className={styles.sectionTitle}>执行指标</h4>

      <div className={styles.statsGrid}>
        {headlineMetrics.map((metric) => (
          <div key={metric.label} className={`${styles.statCard} ${styles.centered}`}>
            <div className={styles.statLabel}>{metric.label}</div>
            <div className={`${styles.statValue} ${styles[metric.tone] ?? ''} ${styles.compact}`}>
              {metric.value}
            </div>
          </div>
        ))}
      </div>

      {latencyRows.length > 0 && (
        <div className={styles.statCard}>
          <div className={styles.cardTitle}>时延分解</div>
          <div className={styles.statBreakdown}>
            {latencyRows.map((item) => (
              <div key={item.label} className={styles.breakdownItem}>
                <span>{item.label}</span>
                <span>{formatMetricDuration(item.value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {executionFacts.length > 0 && (
        <div className={styles.statCard}>
          <div className={styles.cardTitle}>执行事实</div>
          <div className={styles.statBreakdown}>
            {executionFacts.map((item) => (
              <div key={item.label} className={styles.breakdownItem}>
                <span>{item.label}</span>
                <span>{item.value}</span>
              </div>
            ))}
            {chunkSummary ? (
              <div className={`${styles.breakdownItem} ${styles.column}`}>
                <span>Chunk 分布</span>
                <span className={styles.summaryText}>{chunkSummary}</span>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {toolCalls.length > 0 && (
        <div className={styles.statCard}>
          <div className={styles.cardTitle}>工具执行</div>
          <div className={styles.toolSection}>
            {toolCalls.map((toolCall, index) => (
              <div key={`${toolCall.name}-${index}`} className={styles.toolRow}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName}>{toolCall.name}</span>
                  <span
                    className={`${styles.toolStatus} ${
                      toolCall.status === 'success'
                        ? styles.success
                        : toolCall.status === 'error'
                          ? styles.failed
                          : styles.pending
                    }`}
                  >
                    {toolCall.status === 'success'
                      ? 'Success'
                      : toolCall.status === 'error'
                        ? 'Error'
                        : 'Unknown'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {contextFacts.length > 0 && (
        <div className={styles.statCard}>
          <div className={styles.cardTitle}>Trace Context</div>

          {identityFacts.length > 0 && (
            <div className={styles.identityGrid}>
              {identityFacts.map((item) => (
                <div key={item.label} className={styles.identityCard}>
                  <div className={styles.identityLabel}>{item.label}</div>
                  <div className={styles.identityValue}>{item.value}</div>
                </div>
              ))}
            </div>
          )}

          {profileFacts.length > 0 && (
            <div className={styles.factGrid}>
              {profileFacts.map((item) => (
                <div key={item.label} className={styles.factCard}>
                  <div className={styles.factLabel}>{item.label}</div>
                  <div className={styles.factValue}>{item.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
