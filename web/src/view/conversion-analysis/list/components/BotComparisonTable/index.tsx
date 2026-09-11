import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type {
  ConversionBotRow,
  ConversionMetricMode,
} from '@/api/types/conversion-analytics.types';
import heroArt from '@/assets/images/conversion-growth-hero.png';
import { formatLocaleNumber, formatPercent } from '@/utils/format';
import MetricModeTabs from '../MetricModeTabs';
import type { BotSortKey, SortDirection } from '../../types';
import styles from '../../styles/index.module.scss';

interface BotComparisonTableProps {
  rows: ConversionBotRow[];
  loading: boolean;
  mode: ConversionMetricMode;
  maturityDays: number;
  sortKey: BotSortKey;
  sortDirection: SortDirection;
  onModeChange: (mode: ConversionMetricMode) => void;
  onSort: (key: BotSortKey) => void;
}

type ColumnType = 'account' | 'num' | 'rate';

const COLUMNS: Array<{ key: BotSortKey; label: string; type: ColumnType }> = [
  { key: 'managerName', label: '账号 / 小组', type: 'account' },
  { key: 'friends_added', label: '新增好友', type: 'num' },
  { key: 'break_ice', label: '候选人回复', type: 'num' },
  { key: 'group_invite', label: '邀请进群', type: 'num' },
  { key: 'booking_success', label: '报名成功', type: 'num' },
  { key: 'interview_pass', label: '面试通过', type: 'num' },
  { key: 'booking_cancel', label: '取消', type: 'num' },
  { key: 'interview_modified', label: '改约', type: 'num' },
  { key: 'booking_rate', label: '报名成功率', type: 'rate' },
  { key: 'interview_rate', label: '面试通过率', type: 'rate' },
];

export default function BotComparisonTable({
  rows,
  loading,
  mode,
  maturityDays,
  sortKey,
  sortDirection,
  onModeChange,
  onSort,
}: BotComparisonTableProps) {
  return (
    <section className={`${styles.panel} ${styles.botPanel}`}>
      <img className={styles.botPanelArt} src={heroArt} alt="" aria-hidden="true" />
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.sectionKicker}>账号对比</span>
          <h2>账号转化对比</h2>
          <span>
            {rows.length} 个账号 · 点击表头按指标排序 · 各指标按「人」去重 ·{' '}
            {mode === 'period'
              ? '同一时间窗内分别发生；跨账号流转时，账号行之和可能高于全局唯一人数'
              : `追踪至少成熟 ${maturityDays} 天的新增好友批次`}
          </span>
        </div>
        <div className={styles.panelHeaderActions}>
          <MetricModeTabs mode={mode} onChange={onModeChange} label="账号转化对比口径" />
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}>加载中</div>
      ) : rows.length > 0 ? (
        <div className={styles.tableScroll}>
          <table className={styles.botTable}>
            <thead>
              <tr>
                <th className={styles.rankCol}>#</th>
                {COLUMNS.map((col) => {
                  const active = sortKey === col.key;
                  const isNum = col.type === 'num' || col.type === 'rate';
                  return (
                    <th
                      key={col.key}
                      className={joinClasses(
                        col.type === 'account' && styles.accountCol,
                        col.type === 'rate' && styles.rateCol,
                        isNum && styles.numCol,
                        active && styles.sortActive,
                      )}
                      aria-sort={
                        active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                    >
                      <button type="button" onClick={() => onSort(col.key)}>
                        <span>{col.label}</span>
                        {active ? (
                          sortDirection === 'asc' ? (
                            <ArrowUp size={13} />
                          ) : (
                            <ArrowDown size={13} />
                          )
                        ) : (
                          <ChevronsUpDown size={13} className={styles.sortIdle} />
                        )}
                      </button>
                    </th>
                  );
                })}
                <th className={styles.statusCol}>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((bot, index) => (
                <tr
                  key={bot.botImId}
                  className={joinClasses(
                    styles[statusRowClass(bot.status)],
                    index === 0 && styles.rowGold,
                    index === 1 && styles.rowSilver,
                    index === 2 && styles.rowBronze,
                  )}
                >
                  <td className={styles.rankCol}>{renderRankBadge(index)}</td>
                  {COLUMNS.map((col) => (
                    <td key={col.key} className={cellClass(col.type, sortKey === col.key)}>
                      {renderCell(bot, col.type, col.key)}
                    </td>
                  ))}
                  <td className={styles.statusCol}>
                    <span className={`${styles.statusCell} ${styles[statusClass(bot.status)]}`}>
                      <i className={`${styles.statusDot} ${styles[statusClass(bot.status)]}`} />
                      {statusLabel(bot.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.emptyState}>暂无账号数据</div>
      )}
    </section>
  );
}

function renderCell(bot: ConversionBotRow, type: ColumnType, key: BotSortKey) {
  if (type === 'account') {
    return (
      <div className={styles.accountLine}>
        <strong title={bot.managerName}>{bot.managerName}</strong>
        <span className={styles.accountGroup} title={bot.groupName || '未分组'}>
          {bot.groupName || '未分组'}
        </span>
      </div>
    );
  }
  if (type === 'rate') {
    const value = rateValue(bot, key);
    const pct = Math.min(100, Math.max(value * 100, value > 0 ? 3 : 0));
    const isInterview = key === 'interview_rate';
    return (
      <>
        <strong
          className={joinClasses(
            isInterview ? styles.rateValueInterview : styles.rateValueBooking,
            value === 0 && styles.rateZero,
          )}
        >
          {formatPercent(value)}
        </strong>
        <i
          className={`${styles.rateBar} ${isInterview ? styles.rateBarInterview : styles.rateBarBooking}`}
        >
          <b style={{ width: `${pct}%` }} />
        </i>
      </>
    );
  }
  const value = metricValue(bot, key);
  return (
    <span className={joinClasses(styles.metricCount, value === 0 && styles.metricZero)}>
      {formatLocaleNumber(value, 'zh-CN')}
    </span>
  );
}

function renderRankBadge(index: number) {
  const rank = index + 1;
  if (rank <= 3) {
    return (
      <span className={`${styles.rankBadge} ${styles.rankTop}`} aria-label={`第 ${rank} 名`}>
        {rank}
      </span>
    );
  }
  return <span className={styles.rankBadge}>{rank}</span>;
}

function cellClass(type: ColumnType, active: boolean) {
  const isNum = type === 'num' || type === 'rate';
  return joinClasses(
    isNum && styles.numCol,
    type === 'rate' && styles.rateCell,
    type === 'account' && styles.accountCell,
    isNum && active && styles.numActive,
  );
}

function joinClasses(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(' ');
}

function metricValue(bot: ConversionBotRow, key: BotSortKey): number {
  switch (key) {
    case 'friends_added':
    case 'break_ice':
    case 'booking_success':
    case 'group_invite':
    case 'interview_pass':
    case 'booking_cancel':
    case 'interview_modified':
      return bot.eventCounts[key];
    default:
      return 0;
  }
}

// 报名成功率 = 报名成功 / 候选人回复；面试通过率 = 面试通过 / 报名成功。
function rateValue(bot: ConversionBotRow, key: BotSortKey): number {
  if (key === 'booking_rate') {
    return safeRatio(bot.eventCounts.booking_success, bot.eventCounts.break_ice);
  }
  if (key === 'interview_rate') {
    return safeRatio(bot.eventCounts.interview_pass, bot.eventCounts.booking_success);
  }
  return 0;
}

function safeRatio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function statusClass(status: ConversionBotRow['status']) {
  if (status === 'good') return 'statusGood';
  if (status === 'warning') return 'statusWarning';
  return 'statusBad';
}

function statusRowClass(status: ConversionBotRow['status']) {
  if (status === 'good') return 'statusRowGood';
  if (status === 'warning') return 'statusRowWarning';
  return 'statusRowBad';
}

function statusLabel(status: ConversionBotRow['status']) {
  if (status === 'good') return '健康';
  if (status === 'warning') return '观察';
  return '偏低';
}
