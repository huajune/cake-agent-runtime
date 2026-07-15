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

const COHORT_MATURITY_DAYS = 7;

export default function ConversionAnalysis() {
  const [range, setRange] = useState<ConversionRange>('week');
  const [groups, setGroups] = useState<string[]>([]);
  const [metricMode, setMetricMode] = useState<ConversionMetricMode>('cohort');
  const [sortKey, setSortKey] = useState<BotSortKey>('booking_rate');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const query: ConversionQuery = useMemo(
    () => ({
      range,
      groups,
      maturityDays: metricMode === 'cohort' ? COHORT_MATURITY_DAYS : undefined,
    }),
    [groups, metricMode, range],
  );
  const {
    data: kpis,
    isLoading: kpisLoading,
    isFetching: kpisFetching,
    isPlaceholderData: kpisPlaceholder,
    isError: kpisError,
    refetch: refetchKpis,
    dataUpdatedAt,
  } = useConversionKpis(query, metricMode, true);
  const {
    data: trends,
    isLoading: trendsLoading,
    isFetching: trendsFetching,
    isPlaceholderData: trendsPlaceholder,
    isError: trendsError,
    refetch: refetchTrends,
  } = useConversionTrends(query, metricMode, true);
  const {
    data: funnel,
    isLoading: funnelLoading,
    isFetching: funnelFetching,
    isPlaceholderData: funnelPlaceholder,
    isError: funnelError,
    refetch: refetchFunnel,
  } = useConversionFunnel(query, 'friend_added', metricMode, true);
  const {
    data: bots,
    isLoading: botsLoading,
    isFetching: botsFetching,
    isPlaceholderData: botsPlaceholder,
    isError: botsError,
    refetch: refetchBots,
  } = useConversionBots(query, metricMode, true);
  const {
    data: handoff,
    isLoading: handoffLoading,
    isFetching: handoffFetching,
    isPlaceholderData: handoffPlaceholder,
    isError: handoffError,
    refetch: refetchHandoff,
    dataUpdatedAt: handoffUpdatedAt,
  } = useHandoffReasons({ range, groups }, true);
  const lastUpdate = Math.max(dataUpdatedAt ?? 0, handoffUpdatedAt ?? 0) || null;
  const filterRefreshing =
    (kpisFetching && kpisPlaceholder) ||
    (trendsFetching && trendsPlaceholder) ||
    (funnelFetching && funnelPlaceholder) ||
    (botsFetching && botsPlaceholder) ||
    (handoffFetching && handoffPlaceholder);

  // 错误反馈：任一面板请求失败时给出可见提示与重试，全部失败时整页降级为错误态，
  // 避免 API 全挂时页面只剩空白/加载态而无任何反馈。
  const hasError = kpisError || trendsError || funnelError || botsError || handoffError;
  const allError = kpisError && trendsError && funnelError && botsError && handoffError;
  const anyLoading =
    kpisLoading || trendsLoading || funnelLoading || botsLoading || handoffLoading;
  const refetchAll = () => {
    void refetchKpis();
    void refetchTrends();
    void refetchFunnel();
    void refetchBots();
    void refetchHandoff();
  };

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

      {allError && !anyLoading ? (
        <div className={styles.errorState} role="alert">
          <p className={styles.errorTitle}>数据加载失败</p>
          <p className={styles.errorHint}>转化分析数据暂时无法获取，请检查网络或稍后重试。</p>
          <button type="button" className={styles.errorRetry} onClick={refetchAll}>
            重试
          </button>
        </div>
      ) : (
        <>
          {hasError ? (
            <div className={styles.errorBanner} role="alert">
              <span>部分数据加载失败，下方展示可能不完整。</span>
              <button type="button" className={styles.errorBannerRetry} onClick={refetchAll}>
                重试
              </button>
            </div>
          ) : null}

          {filterRefreshing ? (
            <div
              className={styles.refreshBar}
              role="status"
              aria-live="polite"
              aria-label="正在刷新当前筛选的数据"
            />
          ) : null}

          <KpiCards
            data={kpis}
            loading={kpisLoading}
            mode={metricMode}
            maturityDays={COHORT_MATURITY_DAYS}
            onModeChange={setMetricMode}
          />

          <KpiTrendChart
            data={trends}
            loading={trendsLoading}
            mode={metricMode}
            maturityDays={COHORT_MATURITY_DAYS}
            onModeChange={setMetricMode}
          />

          <BotComparisonTable
            rows={sortedBots}
            loading={botsLoading}
            mode={metricMode}
            maturityDays={COHORT_MATURITY_DAYS}
            sortKey={sortKey}
            sortDirection={sortDirection}
            onModeChange={setMetricMode}
            onSort={handleSort}
          />

          <section className={styles.conversionSection}>
            <CohortFunnel
              data={funnel}
              loading={funnelLoading}
              mode={metricMode}
              maturityDays={COHORT_MATURITY_DAYS}
              onModeChange={setMetricMode}
            />
          </section>

          <HandoffPieChart data={handoff} loading={handoffLoading} standalone />
        </>
      )}
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
