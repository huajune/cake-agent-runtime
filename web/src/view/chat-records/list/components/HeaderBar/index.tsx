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
  isLive?: boolean;
}

export default function HeaderBar({
  timeRangeOptions,
  timeRangeIndex,
  onTimeRangeChange,
  sessionStats,
  showAnalytics,
  onToggleAnalytics,
  isLive = false,
}: HeaderBarProps) {
  return (
    <div className={styles.headerBar}>
      {/* 极光氛围背景 */}
      <div className={styles.decorativeBg} />

      {/* 首行：标题 + 实时脉冲 + 装饰文案 */}
      <div className={styles.heading}>
        <h2 className={styles.title}>消息总览</h2>
        <span
          className={`${styles.liveBadge} ${isLive ? styles.connected : ''}`}
          title={isLive ? '已连接实时通道，数据自动刷新' : '实时通道连接中…'}
        >
          <span className={styles.liveDot} />
          {isLive ? '实时' : '连接中'}
        </span>
        <p className={styles.tagline}>企微候选人 ↔ 托管 Bot 的完整会话，按会话聚合，实时同步</p>
      </div>

      {/* 次行：时间筛选 | 统计胶囊 + 消息趋势 */}
      <div className={styles.row}>
        <div className={styles.leftSection}>
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
          {/* 统计胶囊组 */}
          <div className={styles.statsGroup}>
            <div className={`${styles.statItem} ${styles.sessions}`}>
              <span className={styles.statLabel}>会话</span>
              <span key={sessionStats.totalSessions} className={styles.statValue}>
                {sessionStats.totalSessions}
              </span>
            </div>
            <div className={`${styles.statItem} ${styles.messages}`}>
              <span className={styles.statLabel}>消息</span>
              <span key={sessionStats.totalMessages} className={styles.statValue}>
                {sessionStats.totalMessages}
              </span>
            </div>
            <div className={`${styles.statItem} ${styles.active}`}>
              <span className={styles.statLabel}>活跃</span>
              <span key={sessionStats.activeSessions} className={styles.statValue}>
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
    </div>
  );
}
