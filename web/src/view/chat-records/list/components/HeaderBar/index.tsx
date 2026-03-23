import styles from './index.module.scss';

interface TimeRangeOption {
  value: number;
  label: string;
  days: number;
}

interface SessionStats {
  totalSessions: number;
  totalMessages: number;
  activeSessions: number;
}

interface HeaderBarProps {
  timeRangeOptions: TimeRangeOption[];
  timeRangeIndex: number;
  onTimeRangeChange: (index: number) => void;
  sessionStats: SessionStats;
  showAnalytics: boolean;
  onToggleAnalytics: () => void;
}

export default function HeaderBar({
  timeRangeOptions,
  timeRangeIndex,
  onTimeRangeChange,
  sessionStats,
  showAnalytics,
  onToggleAnalytics,
}: HeaderBarProps) {
  return (
    <div className={styles.headerBar}>
      {/* 装饰性背景 */}
      <div className={styles.decorativeBg} />

      {/* 左侧：标题 + 时间筛选 */}
      <div className={styles.leftSection}>
        <div className={styles.titleWrapper}>
          <h2 className={styles.title}>消息总览</h2>
        </div>

        <div className={styles.divider} />

        <div className={styles.filters}>
          {timeRangeOptions.map((option, index) => (
            <button
              key={option.value}
              className={`${styles.filterBtn} ${timeRangeIndex === index ? styles.active : ''}`}
              onClick={() => onTimeRangeChange(index)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* 右侧：统计卡片 + 数据分析按钮 */}
      <div className={styles.rightSection}>
        {/* 统计卡片组 */}
        <div className={styles.statsGroup}>
          <div className={`${styles.statItem} ${styles.sessions}`}>
            <span className={styles.statIcon}>💭</span>
            <span className={styles.statLabel}>会话</span>
            <span className={`${styles.statValue} ${styles.primary}`}>
              {sessionStats.totalSessions}
            </span>
          </div>
          <div className={`${styles.statItem} ${styles.messages}`}>
            <span className={styles.statIcon}>✉️</span>
            <span className={styles.statLabel}>消息</span>
            <span className={`${styles.statValue} ${styles.success}`}>
              {sessionStats.totalMessages}
            </span>
          </div>
          <div className={`${styles.statItem} ${styles.active}`}>
            <span className={styles.statIcon}>🔥</span>
            <span className={styles.statLabel}>活跃</span>
            <span className={`${styles.statValue} ${styles.warning}`}>
              {sessionStats.activeSessions}
            </span>
          </div>
        </div>

        {/* 数据分析按钮 */}
        <button
          className={`${styles.analyticsBtn} ${showAnalytics ? styles.active : ''}`}
          onClick={onToggleAnalytics}
        >
          消息趋势
          <span className={`${styles.analyticsArrow} ${showAnalytics ? styles.expanded : ''}`}>
            ▼
          </span>
        </button>
      </div>
    </div>
  );
}
