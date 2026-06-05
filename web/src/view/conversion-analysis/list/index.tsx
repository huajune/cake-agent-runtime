import { useMemo, useState } from 'react';
import type {
  ConversionBotRow,
  ConversionMetricMode,
  ConversionQuery,
  ConversionRange,
} from '@/api/types/conversion-analytics.types';
import { useConversionBots } from '@/hooks/analytics/useConversionBots';
import { useConversionFunnel } from '@/hooks/analytics/useConversionFunnel';
import { useConversionKpis } from '@/hooks/analytics/useConversionKpis';
import { useConversionTrends } from '@/hooks/analytics/useConversionTrends';
import { useHandoffReasons } from '@/hooks/analytics/useHandoffReasons';
import BotComparisonTable from './components/BotComparisonTable';
import CohortFunnel from './components/CohortFunnel';
import ControlPanel from './components/ControlPanel';
import HandoffPieChart from './components/HandoffPieChart';
import KpiCards from './components/KpiCards';
import KpiTrendChart from './components/KpiTrendChart';
import type { BotSortKey, SortDirection } from './types';
import styles from './styles/index.module.scss';

export default function ConversionAnalysis() {
  const [range, setRange] = useState<ConversionRange>('week');
  const [groups, setGroups] = useState<string[]>([]);
  const [trendMode, setTrendMode] = useState<ConversionMetricMode>('period');
  const [funnelMode, setFunnelMode] = useState<ConversionMetricMode>('period');
  const [botsMode, setBotsMode] = useState<ConversionMetricMode>('period');
  const [sortKey, setSortKey] = useState<BotSortKey>('booking_rate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const query: ConversionQuery = useMemo(() => ({ range, groups }), [groups, range]);
  const {
    data: kpis,
    isLoading: kpisLoading,
    isFetching: kpisFetching,
    isPlaceholderData: kpisPlaceholder,
    dataUpdatedAt,
  } = useConversionKpis(query, 'period', true);
  const {
    data: trends,
    isLoading: trendsLoading,
    isFetching: trendsFetching,
    isPlaceholderData: trendsPlaceholder,
  } = useConversionTrends(query, trendMode, true);
  const {
    data: funnel,
    isLoading: funnelLoading,
    isFetching: funnelFetching,
    isPlaceholderData: funnelPlaceholder,
  } = useConversionFunnel(query, 'friend_added', funnelMode, true);
  const {
    data: bots,
    isLoading: botsLoading,
    isFetching: botsFetching,
    isPlaceholderData: botsPlaceholder,
  } = useConversionBots(query, botsMode, true);
  const {
    data: handoff,
    isLoading: handoffLoading,
    isFetching: handoffFetching,
    isPlaceholderData: handoffPlaceholder,
    dataUpdatedAt: handoffUpdatedAt,
  } = useHandoffReasons({ range, groups }, true);
  const lastUpdate = Math.max(dataUpdatedAt ?? 0, handoffUpdatedAt ?? 0) || null;
  const filterRefreshing =
    (kpisFetching && kpisPlaceholder) ||
    (trendsFetching && trendsPlaceholder) ||
    (funnelFetching && funnelPlaceholder) ||
    (botsFetching && botsPlaceholder) ||
    (handoffFetching && handoffPlaceholder);

  const sortedBots = useMemo(() => {
    const rows = [...(bots?.bots ?? [])];
    return rows.sort((a, b) => {
      const aValue = getBotSortValue(a, sortKey);
      const bValue = getBotSortValue(b, sortKey);
      const result =
        typeof aValue === 'number' && typeof bValue === 'number'
          ? aValue - bValue
          : String(aValue).localeCompare(String(bValue), 'zh-CN');
      return sortDirection === 'asc' ? result : -result;
    });
  }, [bots?.bots, sortDirection, sortKey]);

  const handleSort = (key: BotSortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDirection('desc');
  };

  return (
    <main
      className={`${styles.page} ${filterRefreshing ? styles.pageRefreshing : ''}`}
      aria-busy={filterRefreshing}
    >
      <ControlPanel
        range={range}
        groups={groups}
        lastUpdate={lastUpdate}
        onRangeChange={setRange}
        onGroupsChange={setGroups}
      />

      {filterRefreshing ? (
        <div
          className={styles.refreshBar}
          role="status"
          aria-live="polite"
          aria-label="正在刷新当前筛选的数据"
        />
      ) : null}

      <KpiCards data={kpis} loading={kpisLoading} />

      <KpiTrendChart
        data={trends}
        loading={trendsLoading}
        mode={trendMode}
        onModeChange={setTrendMode}
      />

      <section className={styles.conversionSection}>
        <CohortFunnel
          data={funnel}
          loading={funnelLoading}
          mode={funnelMode}
          onModeChange={setFunnelMode}
        />
      </section>

      <BotComparisonTable
        rows={sortedBots}
        loading={botsLoading}
        mode={botsMode}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onModeChange={setBotsMode}
        onSort={handleSort}
      />

      <HandoffPieChart data={handoff} loading={handoffLoading} standalone />
    </main>
  );
}

function getBotSortValue(row: ConversionBotRow, key: BotSortKey) {
  if (key === 'managerName') return row.managerName;
  if (key === 'groupName') return row.groupName;
  // 报名成功率 = 报名成功 / 候选人回复；面试通过率 = 面试通过 / 报名成功。
  if (key === 'booking_rate') {
    return safeRatio(row.eventCounts.booking_success, row.eventCounts.break_ice);
  }
  if (key === 'interview_rate') {
    return safeRatio(row.eventCounts.interview_pass, row.eventCounts.booking_success);
  }
  return row.eventCounts[key];
}

function safeRatio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
