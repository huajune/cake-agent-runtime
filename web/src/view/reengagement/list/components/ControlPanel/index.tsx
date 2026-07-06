import { useState, useCallback } from 'react';
import { Filter, Workflow } from 'lucide-react';
import { SCENARIO_OPTIONS, STATUS_OPTIONS } from '../../constants';
import styles from './index.module.scss';

export interface ReengagementStatsSummary {
  total: number;
  sent: number;
  shadow: number;
  unknown: number;
}

interface ControlPanelProps {
  stats: ReengagementStatsSummary;
  timeRange: 'today' | 'week' | 'month';
  onTimeRangeChange: (range: 'today' | 'week' | 'month') => void;
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  scenarioFilter: string;
  onScenarioFilterChange: (value: string) => void;
  searchSessionId: string;
  onSearchSessionIdChange: (sessionId: string) => void;
  allValue: string;
}

const TIME_RANGE_OPTIONS = [
  { key: 'today' as const, label: '今天' },
  { key: 'week' as const, label: '近7天' },
  { key: 'month' as const, label: '近30天' },
];

export default function ControlPanel({
  stats,
  timeRange,
  onTimeRangeChange,
  statusFilter,
  onStatusFilterChange,
  scenarioFilter,
  onScenarioFilterChange,
  searchSessionId,
  onSearchSessionIdChange,
  allValue,
}: ControlPanelProps) {
  const [inputValue, setInputValue] = useState(searchSessionId);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleSearch = useCallback(() => {
    onSearchSessionIdChange(inputValue.trim());
  }, [inputValue, onSearchSessionIdChange]);

  const handleBlur = useCallback(() => {
    const trimmedValue = inputValue.trim();
    if (trimmedValue !== searchSessionId) {
      onSearchSessionIdChange(trimmedValue);
    }
  }, [inputValue, searchSessionId, onSearchSessionIdChange]);

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
    onSearchSessionIdChange('');
  }, [onSearchSessionIdChange]);

  const statBadges = [
    { label: '总触达', value: String(stats.total), toneClass: styles.badgePrimary },
    { label: '已投递', value: String(stats.sent), toneClass: styles.badgeSuccess },
    { label: 'Shadow', value: String(stats.shadow), toneClass: styles.badgeNeutral },
    {
      label: '状态不明',
      value: String(stats.unknown),
      toneClass: stats.unknown > 0 ? styles.badgeDanger : '',
    },
  ];

  return (
    <section className={`control-panel ${styles.panel}`}>
      <div className={styles.row}>
        <h3 className={styles.title}>二次触发追溯</h3>

        <div className={styles.timeRangeGroup}>
          {TIME_RANGE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onTimeRangeChange(option.key)}
              className={`${styles.segBtn} ${timeRange === option.key ? styles.segBtnActive : ''}`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className={styles.searchWrap}>
          <input
            type="text"
            placeholder="检索 Session ID..."
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

        <label className={styles.selectWrap}>
          <Filter aria-hidden="true" size={14} />
          <select
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.target.value)}
            className={styles.selectInput}
            aria-label="状态筛选"
          >
            <option value={allValue}>全部状态</option>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectWrap}>
          <Workflow aria-hidden="true" size={14} />
          <select
            value={scenarioFilter}
            onChange={(event) => onScenarioFilterChange(event.target.value)}
            className={styles.selectInput}
            aria-label="场景筛选"
          >
            <option value={allValue}>全部场景</option>
            {SCENARIO_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <div className={styles.statsGroup}>
          {statBadges.map((item) => (
            <span key={item.label} className={`${styles.statBadge} ${item.toneClass}`}>
              <span className={styles.statBadgeLabel}>{item.label}</span>
              <span className={styles.statBadgeValue}>{item.value}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
