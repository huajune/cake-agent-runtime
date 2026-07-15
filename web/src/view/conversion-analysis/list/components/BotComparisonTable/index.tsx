import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type {
  ConversionBotRow,
  ConversionMetricMode,
} from '@/api/types/conversion-analytics.types';
import heroArt from '@/assets/images/conversion-growth-hero.png';
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
      {value.toLocaleString('zh-CN')}
    </span>
  );
}

function renderRankBadge(index: number) {
  const rank = index + 1;

  if (rank === 1) {
    return (
      <span
        className={`${styles.rankBadge} ${styles.rankTop} ${styles.rankGold}`}
        title="冠军"
        aria-label="冠军，第 1 名"
      >
        <RankIcon rank={1} />
      </span>
    );
  }

  if (rank === 2) {
    return (
      <span
        className={`${styles.rankBadge} ${styles.rankTop} ${styles.rankSilver}`}
        title="亚军"
        aria-label="亚军，第 2 名"
      >
        <RankIcon rank={2} />
      </span>
    );
  }

  if (rank === 3) {
    return (
      <span
        className={`${styles.rankBadge} ${styles.rankTop} ${styles.rankBronze}`}
        title="季军"
        aria-label="季军，第 3 名"
      >
        <RankIcon rank={3} />
      </span>
    );
  }

  return <span className={styles.rankBadge}>{rank}</span>;
}

function RankIcon({ rank }: { rank: 1 | 2 | 3 }) {
  if (rank === 1) {
    return (
      <svg className={styles.rankIcon} viewBox="0 0 40 40" role="img" aria-hidden="true">
        <defs>
          <linearGradient id="rank1CrownFill" x1="9" x2="31" y1="8" y2="30">
            <stop offset="0%" stopColor="#fff7ed" />
            <stop offset="36%" stopColor="#fde68a" />
            <stop offset="72%" stopColor="#fbbf24" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
          <radialGradient id="rank1Gem" cx="50%" cy="38%" r="58%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="58%" stopColor="#f472b6" />
            <stop offset="100%" stopColor="#db2777" />
          </radialGradient>
        </defs>
        <path
          d="M6.5 9.8h3.2M30.3 9.8h3.2M20 3.9v3.2"
          fill="none"
          stroke="#fbbf24"
          strokeLinecap="round"
          strokeWidth="1.3"
        />
        <path
          d="M8.4 29.5c1.4 2 4.1 3.2 7.4 3.6M31.6 29.5c-1.4 2-4.1 3.2-7.4 3.6"
          fill="none"
          stroke="#f59e0b"
          strokeLinecap="round"
          strokeWidth="1.4"
        />
        <ellipse
          cx="10.4"
          cy="28.4"
          fill="#fde68a"
          rx="1.2"
          ry="2"
          transform="rotate(-35 10.4 28.4)"
        />
        <ellipse
          cx="13.3"
          cy="30.7"
          fill="#fde68a"
          rx="1.1"
          ry="1.8"
          transform="rotate(-55 13.3 30.7)"
        />
        <ellipse
          cx="29.6"
          cy="28.4"
          fill="#fde68a"
          rx="1.2"
          ry="2"
          transform="rotate(35 29.6 28.4)"
        />
        <ellipse
          cx="26.7"
          cy="30.7"
          fill="#fde68a"
          rx="1.1"
          ry="1.8"
          transform="rotate(55 26.7 30.7)"
        />
        <path
          d="M8.6 25.9 10.2 11l6.2 6.2L20 7.7l3.6 9.5 6.2-6.2 1.6 14.9Z"
          fill="url(#rank1CrownFill)"
          stroke="#f59e0b"
          strokeLinejoin="round"
          strokeWidth="1.35"
        />
        <path
          d="M11 24.5h18l-1.2 6.1H12.2Z"
          fill="#fff7ed"
          stroke="#f59e0b"
          strokeLinejoin="round"
          strokeWidth="1.25"
        />
        <path
          d="M12.7 22.4c3.6 1.3 10.9 1.3 14.6 0"
          fill="none"
          stroke="rgba(255,255,255,.86)"
          strokeLinecap="round"
          strokeWidth="1.45"
        />
        <circle cx="20" cy="22.1" r="2.3" fill="url(#rank1Gem)" stroke="#fff" strokeWidth="1.1" />
        <circle cx="10.2" cy="11" r="1.5" fill="#fef3c7" />
        <circle cx="20" cy="7.8" r="1.8" fill="#fef3c7" />
        <circle cx="29.8" cy="11" r="1.5" fill="#fef3c7" />
        <path
          d="M15.2 28.1h9.6"
          fill="none"
          stroke="#f59e0b"
          strokeLinecap="round"
          strokeWidth="1.3"
        />
      </svg>
    );
  }

  const isSilver = rank === 2;
  const fillId = `rank${rank}MedalFill`;
  const rimId = `rank${rank}MedalRim`;
  const medal = isSilver
    ? {
        fillStops: ['#ffffff', '#e0f2fe', '#bfdbfe'],
        rimStops: ['#f8fafc', '#bfdbfe', '#60a5fa'],
        ribbonStops: ['#818cf8', '#38bdf8'],
        text: '#3b82f6',
        star: '#60a5fa',
      }
    : {
        fillStops: ['#fff7ed', '#fed7aa', '#fdba74'],
        rimStops: ['#fff7ed', '#fdba74', '#fb923c'],
        ribbonStops: ['#a78bfa', '#f59e0b'],
        text: '#ea580c',
        star: '#f97316',
      };
  return (
    <svg className={styles.rankIcon} viewBox="0 0 40 40" role="img" aria-hidden="true">
      <defs>
        <linearGradient id={fillId} x1="12" x2="28" y1="17" y2="34">
          <stop offset="0%" stopColor={medal.fillStops[0]} />
          <stop offset="55%" stopColor={medal.fillStops[1]} />
          <stop offset="100%" stopColor={medal.fillStops[2]} />
        </linearGradient>
        <linearGradient id={rimId} x1="11" x2="30" y1="16" y2="35">
          <stop offset="0%" stopColor={medal.rimStops[0]} />
          <stop offset="54%" stopColor={medal.rimStops[1]} />
          <stop offset="100%" stopColor={medal.rimStops[2]} />
        </linearGradient>
        <linearGradient id={`rankRibbon${rank}`} x1="11" x2="29" y1="4" y2="20">
          <stop offset="0%" stopColor={medal.ribbonStops[0]} />
          <stop offset="100%" stopColor={medal.ribbonStops[1]} />
        </linearGradient>
      </defs>
      <path
        d="m13.2 5.2 4.8 12.3-5.1 2.3L8.6 8.7c-.4-1 .3-2 1.3-2.1Z"
        fill={`url(#rankRibbon${rank})`}
        opacity=".84"
      />
      <path
        d="m26.8 5.2-4.8 12.3 5.1 2.3 4.3-11.1c.4-1-.3-2-1.3-2.1Z"
        fill={`url(#rankRibbon${rank})`}
        opacity=".72"
      />
      <circle
        cx="20"
        cy="25.1"
        r="11.3"
        fill={`url(#${rimId})`}
        stroke="rgba(255,255,255,.88)"
        strokeWidth="1.5"
      />
      <circle
        cx="20"
        cy="25.1"
        r="8"
        fill={`url(#${fillId})`}
        stroke="rgba(255,255,255,.8)"
        strokeWidth="1"
      />
      <path
        d="m20 17.4 1.8 3.5 3.9.6-2.8 2.7.7 3.8-3.6-1.8-3.5 1.8.7-3.8-2.8-2.7 3.9-.6Z"
        fill={medal.star}
        opacity=".9"
      />
      <path
        d="M15.6 21.2c2.2-1.5 6.6-1.5 8.8 0"
        fill="none"
        stroke="rgba(255,255,255,.82)"
        strokeLinecap="round"
        strokeWidth="1.25"
      />
      <text x="20" y="28.7" fill={medal.text} fontSize="8.8" fontWeight="900" textAnchor="middle">
        {rank}
      </text>
    </svg>
  );
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

function formatPercent(value?: number) {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}
