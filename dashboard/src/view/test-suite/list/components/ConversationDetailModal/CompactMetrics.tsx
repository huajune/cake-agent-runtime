import { memo } from 'react';
import { Activity, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { getScoreStyleClass, getScoreRating, formatDuration, formatPercent } from '../../utils';
import styles from './index.module.scss';

interface CompactMetricsProps {
  similarityScore: number | null;
  status: string;
  durationMs: number | null;
}

/**
 * 紧凑指标条组件
 */
export const CompactMetrics = memo(function CompactMetrics({
  similarityScore,
  status,
  durationMs,
}: CompactMetricsProps) {
  return (
    <div className={styles.compactMetrics}>
      <div className={styles.metricItem}>
        <Activity size={14} />
        <span className={`${styles.metricValue} ${styles[getScoreStyleClass(similarityScore)]}`}>
          {formatPercent(similarityScore)}
        </span>
        <span className={styles.metricLabel}>相似度</span>
        <span className={styles.metricRating}>({getScoreRating(similarityScore)})</span>
      </div>
      <div className={styles.metricDivider} />
      <div className={styles.metricItem}>
        <Clock size={14} />
        <span className={styles.metricValue}>{formatDuration(durationMs)}</span>
        <span className={styles.metricLabel}>耗时</span>
      </div>
      <div className={styles.metricDivider} />
      <div className={`${styles.statusBadge} ${styles[status] || ''}`}>
        {status === 'success' ? (
          <>
            <CheckCircle2 size={12} /> 成功
          </>
        ) : status === 'failed' ? (
          <>
            <AlertTriangle size={12} /> 失败
          </>
        ) : (
          <>
            <Clock size={12} /> 待执行
          </>
        )}
      </div>
    </div>
  );
});
