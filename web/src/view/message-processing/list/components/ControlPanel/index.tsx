import { useState, useCallback } from 'react';
import { formatDuration } from '@/utils/format';
import styles from './index.module.scss';

interface Stats {
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
}

interface ControlPanelProps {
  stats: Stats;
  activeTab: 'realtime' | 'slowest';
  onTabChange: (tab: 'realtime' | 'slowest') => void;
  realtimeCount: number;
  slowestCount: number;
  timeRange: 'today' | 'week' | 'month';
  onTimeRangeChange: (range: 'today' | 'week' | 'month') => void;
  searchUserName?: string;
  onSearchUserNameChange?: (userName: string) => void;
}

const TIME_RANGE_OPTIONS = [
  { key: 'today' as const, label: '今天' },
  { key: 'week' as const, label: '近7天' },
  { key: 'month' as const, label: '近30天' },
];

const TAB_OPTIONS = [
  { key: 'realtime' as const, label: '实时流水' },
  { key: 'slowest' as const, label: '高时延 Top' },
];

export default function ControlPanel({
  stats,
  activeTab,
  onTabChange,
  realtimeCount,
  slowestCount,
  timeRange,
  onTimeRangeChange,
  searchUserName = '',
  onSearchUserNameChange,
}: ControlPanelProps) {
  const [inputValue, setInputValue] = useState(searchUserName);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleSearch = useCallback(() => {
    onSearchUserNameChange?.(inputValue.trim());
  }, [inputValue, onSearchUserNameChange]);

  const handleBlur = useCallback(() => {
    const trimmedValue = inputValue.trim();
    if (trimmedValue !== searchUserName) {
      onSearchUserNameChange?.(trimmedValue);
    }
  }, [inputValue, searchUserName, onSearchUserNameChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleSearch();
      }
    },
    [handleSearch],
  );

  const handleClear = useCallback(() => {
    setInputValue('');
    onSearchUserNameChange?.('');
  }, [onSearchUserNameChange]);

  const statItems = [
    {
      label: '处理总量',
      value: String(stats.total),
      toneClass: styles.statPrimary,
    },
    {
      label: '成功量',
      value: String(stats.success),
      toneClass: styles.statSuccess,
    },
    {
      label: '异常量',
      value: String(stats.failed),
      toneClass: stats.failed > 0 ? styles.statDanger : '',
    },
    {
      label: '平均 E2E 时延',
      value: formatDuration(stats.avgDuration),
      toneClass: styles.statWarning,
    },
  ];

  return (
    <section
      className={`control-panel ${styles.panel}`}
      style={{
        marginBottom: '20px',
        padding: '16px 20px',
      }}
    >
      <div className={styles.topRow}>
        <div className={styles.leftGroup}>
          <h3 className={styles.title}>消息处理流水</h3>

          <div className={styles.timeRangeGroup}>
            {TIME_RANGE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => onTimeRangeChange(option.key)}
                className={`${styles.timeRangeButton} ${
                  timeRange === option.key ? styles.timeRangeButtonActive : ''
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className={styles.searchWrap}>
            <input
              type="text"
              placeholder="检索会话主体..."
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              className={styles.searchInput}
            />
            {inputValue && (
              <button
                type="button"
                onClick={handleClear}
                className={styles.clearButton}
                aria-label="清空搜索"
                title="清空搜索"
              >
                ×
              </button>
            )}
          </div>
        </div>

        <div className={styles.tabGroup}>
          {TAB_OPTIONS.map((option) => {
            const isActive = activeTab === option.key;
            const count = option.key === 'realtime' ? realtimeCount : slowestCount;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => onTabChange(option.key)}
                className={`${styles.tabButton} ${
                  isActive ? styles.tabButtonActive : ''
                } ${isActive && option.key === 'slowest' ? styles.tabButtonDangerActive : ''}`}
              >
                {option.label}
                <span className={styles.tabCount}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.statsGrid}>
        {statItems.map((item) => (
          <div key={item.label} className={styles.statCard}>
            <span className={styles.statLabel}>{item.label}</span>
            <span className={`${styles.statValue} ${item.toneClass}`}>{item.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
