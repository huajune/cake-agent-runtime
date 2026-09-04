import { useState, useCallback } from 'react';
import { Bot, ChevronDown, Search, X } from 'lucide-react';
import { formatLocaleNumber } from '@/utils/format';
import styles from './index.module.scss';

interface Stats {
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
  avgTtft?: number;
}

type TimeRange = 'today' | 'week' | 'month';
type ViewTab = 'realtime' | 'slowest';

interface ControlPanelProps {
  stats: Stats;
  activeTab: ViewTab;
  onTabChange: (tab: ViewTab) => void;
  realtimeCount: number;
  slowestCount: number;
  timeRange: TimeRange;
  onTimeRangeChange: (range: TimeRange) => void;
  searchUserName?: string;
  onSearchUserNameChange?: (userName: string) => void;
  botFilter: string;
  botOptions: Array<{ value: string; label: string }>;
  isBotsLoading?: boolean;
  allBotsValue: string;
  onBotFilterChange: (value: string) => void;
}

interface StatChip {
  key: string;
  label: string;
  value: string;
  toneClass: string;
}

const TIME_RANGE_OPTIONS: Array<{ key: TimeRange; label: string }> = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '近7天' },
  { key: 'month', label: '近30天' },
];

const TAB_OPTIONS: Array<{ key: ViewTab; label: string }> = [
  { key: 'realtime', label: '实时请求' },
  { key: 'slowest', label: '高时延 Top' },
];

function formatSeconds(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  return `${(ms / 1000).toFixed(2)} 秒`;
}

function buildStatChips(stats: Stats): StatChip[] {
  return [
    {
      key: 'total',
      label: '请求数',
      value: formatLocaleNumber(stats.total),
      toneClass: styles.chipPrimary,
    },
    {
      key: 'success',
      label: '成功',
      value: formatLocaleNumber(stats.success),
      toneClass: styles.chipSuccess,
    },
    {
      key: 'failed',
      label: '异常',
      value: formatLocaleNumber(stats.failed),
      toneClass: stats.failed > 0 ? styles.chipDanger : styles.chipNeutral,
    },
    {
      key: 'ttft',
      label: 'TTFT',
      value: formatSeconds(stats.avgTtft),
      toneClass: styles.chipWarning,
    },
  ];
}

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
  botFilter,
  botOptions,
  isBotsLoading = false,
  allBotsValue,
  onBotFilterChange,
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

  const statChips = buildStatChips(stats);

  const selectPlaceholder = isBotsLoading
    ? '正在加载托管账号'
    : botOptions.length === 0
      ? '暂无托管账号'
      : '全部托管账号';

  return (
    <section className={styles.panel}>
      <div className={styles.heading}>
        <h2 className={styles.title}>处理请求流水</h2>
        <p className={styles.tagline}>
          企微入站 → Agent 处理 → 出站投递，全链路回合 Realtime 自动刷新
        </p>
      </div>

      <div className={styles.row}>
        <div className={styles.segment} role="group" aria-label="时间范围">
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

        <div className={styles.search}>
          <Search size={14} strokeWidth={2} aria-hidden="true" className={styles.searchIcon} />
          <input
            type="text"
            placeholder="检索会话主体"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className={styles.searchInput}
            aria-label="检索会话主体"
          />
          {inputValue && (
            <button
              type="button"
              onClick={handleClear}
              className={styles.clearBtn}
              aria-label="清空搜索"
              title="清空搜索"
            >
              <X size={11} strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
        </div>

        <label className={styles.select}>
          <Bot size={14} strokeWidth={2} aria-hidden="true" className={styles.selectIcon} />
          <select
            value={botFilter}
            onChange={(event) => onBotFilterChange(event.target.value)}
            className={styles.selectInput}
            aria-label="托管 BOT 筛选"
            disabled={isBotsLoading || botOptions.length === 0}
          >
            <option value={allBotsValue}>{selectPlaceholder}</option>
            {botOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className={styles.selectChevron}
          />
        </label>

        <div className={styles.stats}>
          {statChips.map((chip) => (
            <span key={chip.key} className={`${styles.chip} ${chip.toneClass}`}>
              <span className={styles.chipLabel}>{chip.label}</span>
              <span className={styles.chipValue}>{chip.value}</span>
            </span>
          ))}
        </div>

        <div className={styles.viewSwitch} role="tablist" aria-label="视图切换">
          {TAB_OPTIONS.map((option) => {
            const isActive = activeTab === option.key;
            const count = option.key === 'realtime' ? realtimeCount : slowestCount;
            const showCount = option.key === 'realtime' || count > 0;
            return (
              <button
                key={option.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onTabChange(option.key)}
                className={`${styles.viewBtn} ${isActive ? styles.viewBtnActive : ''}`}
              >
                {option.label}
                {showCount && <span className={styles.viewCount}>{formatLocaleNumber(count)}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
