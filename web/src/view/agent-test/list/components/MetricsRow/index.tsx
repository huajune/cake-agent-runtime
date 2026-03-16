import { Clock, Zap } from 'lucide-react';
import { TokenUsage } from '@/api/services/agent-test.service';
import styles from './index.module.scss';

export interface MetricsRowProps {
  durationMs: number;
  tokenUsage: TokenUsage;
  showDetails?: boolean;
}

/**
 * 指标展示行组件
 */
export function MetricsRow({ durationMs, tokenUsage, showDetails = true }: MetricsRowProps) {
  return (
    <div className={styles.metricsRow}>
      <div className={styles.metricCard}>
        <span className={styles.metricValue}>{(durationMs / 1000).toFixed(1)}s</span>
        <span className={styles.metricLabel}>
          <Clock size={10} /> 耗时
        </span>
      </div>
      <div className={styles.metricCard}>
        <span className={styles.metricValue}>{tokenUsage.totalTokens}</span>
        <span className={styles.metricLabel}>
          <Zap size={10} /> Total Tokens
        </span>
      </div>
      {showDetails && (
        <>
          <div className={styles.metricCard}>
            <span className={styles.metricValue}>{tokenUsage.inputTokens}</span>
            <span className={styles.metricLabel}>Input</span>
          </div>
          <div className={styles.metricCard}>
            <span className={styles.metricValue}>{tokenUsage.outputTokens}</span>
            <span className={styles.metricLabel}>Output</span>
          </div>
        </>
      )}
    </div>
  );
}
