import { BatchStats } from '@/api/services/agent-test.service';
import { Layers, CheckCircle2, XCircle, Clock, Activity, Timer } from 'lucide-react';
import styles from './index.module.scss';

interface StatsRowProps {
  stats: BatchStats;
  /** 测试类型：scenario(用例测试) 或 conversation(回归验证) */
  testType?: 'scenario' | 'conversation';
}

/**
 * 统计卡片行组件
 * 根据测试类型显示不同的统计指标
 */
export function StatsRow({ stats, testType = 'scenario' }: StatsRowProps) {
  const isConversation = testType === 'conversation';
  return (
    <div className={styles.statsRow}>
      <div className={styles.statCard}>
        <div className={styles.statValue}>{stats.totalCases}</div>
        <div className={styles.statLabel}>
          <Layers size={12} />
          {isConversation ? '总对话' : '总用例'}
        </div>
      </div>
      <div className={styles.divider} />

      {/* 用例测试：显示通过/失败/待评审 */}
      {!isConversation && (
        <>
          <div className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.success}`}>{stats.passedCount}</div>
            <div className={styles.statLabel}>
              <CheckCircle2 size={12} />
              通过
            </div>
          </div>
          <div className={styles.divider} />
          <div className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.danger}`}>{stats.failedCount}</div>
            <div className={styles.statLabel}>
              <XCircle size={12} />
              失败
            </div>
          </div>
          <div className={styles.divider} />
          <div className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.warning}`}>{stats.pendingReviewCount}</div>
            <div className={styles.statLabel}>
              <Clock size={12} />
              待评审
            </div>
          </div>
          <div className={styles.divider} />
        </>
      )}

      {/* 回归验证：显示已执行/待执行 */}
      {isConversation && (
        <>
          <div className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.success}`}>{stats.passedCount}</div>
            <div className={styles.statLabel}>
              <CheckCircle2 size={12} />
              已执行
            </div>
          </div>
          <div className={styles.divider} />
          <div className={styles.statCard}>
            <div className={`${styles.statValue} ${styles.warning}`}>{stats.pendingReviewCount}</div>
            <div className={styles.statLabel}>
              <Clock size={12} />
              待执行
            </div>
          </div>
          <div className={styles.divider} />
        </>
      )}

      <div className={styles.statCard}>
        <div className={styles.statValue}>
          {stats.passRate !== null
            ? isConversation
              ? `${stats.passRate.toFixed(1)}分`
              : `${stats.passRate.toFixed(1)}%`
            : '-'}
        </div>
        <div className={styles.statLabel}>
          <Activity size={12} />
          {isConversation ? '平均评分' : '通过率'}
        </div>
      </div>
      <div className={styles.divider} />
      <div className={styles.statCard}>
        <div className={styles.statValue}>
          {stats.avgDurationMs ? `${(stats.avgDurationMs / 1000).toFixed(1)}s` : '-'}
        </div>
        <div className={styles.statLabel}>
          <Timer size={12} />
          平均耗时
        </div>
      </div>
    </div>
  );
}

export default StatsRow;
