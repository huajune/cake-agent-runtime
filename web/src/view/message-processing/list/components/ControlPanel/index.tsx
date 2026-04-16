import { useState, useCallback } from 'react';
import { formatDuration } from '@/utils/format';
import styles from './index.module.scss';

interface Stats {
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
  avgTtft?: number;
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
  { key: 'realtime' as const, label: '实时请求' },
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

  const statBadges = [
    { label: '请求数', value: String(stats.total), toneClass: styles.badgePrimary },
    { label: '成功', value: String(stats.success), toneClass: styles.badgeSuccess },
    { label: '异常', value: String(stats.failed), toneClass: stats.failed > 0 ? styles.badgeDanger : '' },
    { label: 'TTFT', value: formatDuration(stats.avgTtft ?? 0), toneClass: styles.badgeWarning },
  ];

  return (
    <section className={`control-panel ${styles.panel}`}>
      <div className={styles.row}>
        <h3 className={styles.title}>处理请求流水</h3>

        <div className={styles.timeRangeGroup}>
          {TIME_RANGE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onTimeRangeChange(option.key)}
              className={`${styles.segBtn} ${
                timeRange === option.key ? styles.segBtnActive : ''
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
              className={styles.clearBtn}
              aria-label="清空搜索"
              title="清空搜索"
            >
              ×
            </button>
          )}
        </div>

        <div className={styles.statsGroup}>
          {statBadges.map((item) => (
            <span key={item.label} className={`${styles.statBadge} ${item.toneClass}`}>
              <span className={styles.statBadgeLabel}>{item.label}</span>
              <span className={styles.statBadgeValue}>{item.value}</span>
            </span>
          ))}
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
                className={`${styles.segBtn} ${
                  isActive ? styles.segBtnActive : ''
                } ${isActive && option.key === 'slowest' ? styles.segBtnDangerActive : ''}`}
              >
                {option.label}
                <span className={styles.tabCount}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
