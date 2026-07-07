import { useState, useMemo, useCallback, useEffect } from 'react';
import InfiniteScroll from 'react-infinite-scroll-component';
import {
  useReengagementCandidates,
  useReengagementRecords,
  useReengagementScenarios,
  useReengagementStats,
} from '@/hooks/reengagement/useReengagementRecords';
import { buildScenarioLabels, buildScenarioOptions } from './constants';
import ControlPanel, { type ReengagementViewMode } from './components/ControlPanel';
import ReengagementTable from './components/ReengagementTable';
import CandidateTable from './components/CandidateTable';
import ReengagementDetailDrawer from './components/ReengagementDetailDrawer';
import type {
  ReengagementCandidateSummary,
  ReengagementTouchRecord,
} from '@/api/types/reengagement.types';
import { addDays, formatDateKey } from '@/utils/date-range';

const ALL_VALUE = '__all__';
const PAGE_SIZE = 50;
const CANDIDATE_PAGE_SIZE = 30;

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function ReengagementPage() {
  // 默认候选人视角：运营主问题是"接下来会给谁发什么"，流水视图用于排查单次触达
  const [viewMode, setViewMode] = useState<ReengagementViewMode>('candidates');
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('week');
  const [statusFilter, setStatusFilter] = useState<string>(ALL_VALUE);
  const [scenarioFilter, setScenarioFilter] = useState<string>(ALL_VALUE);
  const [searchSessionId, setSearchSessionId] = useState<string>('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [selectedTouchKey, setSelectedTouchKey] = useState<string | null>(null);

  // 分页状态：offset 分页 + 无限滚动累加
  const [page, setPage] = useState(1);
  const [accumulatedRecords, setAccumulatedRecords] = useState<ReengagementTouchRecord[]>([]);
  const [hasMore, setHasMore] = useState(true);

  // 候选人视角独立分页累加（与流水视图互不干扰）
  const [candidatePage, setCandidatePage] = useState(1);
  const [accumulatedCandidates, setAccumulatedCandidates] = useState<
    ReengagementCandidateSummary[]
  >([]);
  const [candidatesHasMore, setCandidatesHasMore] = useState(true);

  // 计算时间范围（本地日期口径：toISOString 是 UTC 日期，凌晨 0-8 点会算成昨天）
  const dateRange = useMemo(() => {
    const now = new Date();
    const endDate = formatDateKey(now);
    const startDate =
      timeRange === 'today'
        ? endDate
        : formatDateKey(addDays(now, timeRange === 'week' ? -7 : -30));
    return { startDate, endDate };
  }, [timeRange]);

  const activeStatus = statusFilter !== ALL_VALUE ? statusFilter : undefined;
  const activeScenario = scenarioFilter !== ALL_VALUE ? scenarioFilter : undefined;
  const activeSessionId = searchSessionId || undefined;

  // 筛选条件标识：任一变化都要重置分页与累加数据
  const filterKey = useMemo(
    () =>
      [
        dateRange.startDate,
        dateRange.endDate,
        activeStatus || '',
        activeScenario || '',
        activeSessionId || '',
      ].join('|'),
    [dateRange, activeStatus, activeScenario, activeSessionId],
  );

  const resetPaging = useCallback(() => {
    setPage(1);
    setAccumulatedRecords([]);
    setHasMore(true);
    setCandidatePage(1);
    setAccumulatedCandidates([]);
    setCandidatesHasMore(true);
  }, []);

  const handleViewModeChange = useCallback(
    (mode: ReengagementViewMode) => {
      setViewMode(mode);
      resetPaging();
    },
    [resetPaging],
  );

  const handlePendingOnlyChange = useCallback(
    (value: boolean) => {
      setPendingOnly(value);
      resetPaging();
    },
    [resetPaging],
  );

  const handleTimeRangeChange = useCallback(
    (newRange: 'today' | 'week' | 'month') => {
      setTimeRange(newRange);
      resetPaging();
    },
    [resetPaging],
  );

  const handleStatusFilterChange = useCallback(
    (value: string) => {
      setStatusFilter(value);
      resetPaging();
    },
    [resetPaging],
  );

  const handleScenarioFilterChange = useCallback(
    (value: string) => {
      setScenarioFilter(value);
      resetPaging();
    },
    [resetPaging],
  );

  const handleSearchSessionIdChange = useCallback(
    (sessionId: string) => {
      setSearchSessionId(sessionId);
      resetPaging();
    },
    [resetPaging],
  );

  // 场景中文名以注册表接口为单一来源（与 /config 页同名），接口未返回时用本地兜底
  const { data: scenarioRegistry } = useReengagementScenarios();
  const scenarioLabels = useMemo(() => buildScenarioLabels(scenarioRegistry), [scenarioRegistry]);
  const scenarioOptions = useMemo(() => buildScenarioOptions(scenarioLabels), [scenarioLabels]);

  // 统计数据：分组计数（status x scenario_code）
  const { data: statsItems } = useReengagementStats({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  });

  const stats = useMemo(() => {
    const summary = { total: 0, sent: 0, shadow: 0, unknown: 0 };
    for (const item of statsItems || []) {
      summary.total += item.cnt;
      if (item.status === 'sent') summary.sent += item.cnt;
      if (item.status === 'shadow') summary.shadow += item.cnt;
      if (item.status === 'unknown') summary.unknown += item.cnt;
    }
    return summary;
  }, [statsItems]);

  // 当前页数据（流水视图）
  const {
    data: pageRecords,
    isLoading: pageLoading,
    isError: pageError,
  } = useReengagementRecords({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    status: activeStatus,
    scenarioCode: activeScenario,
    sessionId: activeSessionId,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    enabled: viewMode === 'ledger',
  });

  // 当前页数据（候选人视角）
  const {
    data: candidatePageData,
    isLoading: candidatesLoading,
    isError: candidatesError,
  } = useReengagementCandidates({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    scenarioCode: activeScenario,
    sessionId: activeSessionId,
    pendingOnly,
    limit: CANDIDATE_PAGE_SIZE,
    offset: (candidatePage - 1) * CANDIDATE_PAGE_SIZE,
    enabled: viewMode === 'candidates',
  });

  // 累加分页数据：用 Map 按 touch_key 覆盖，避免翻页边界重复
  useEffect(() => {
    if (!pageRecords) return;
    setHasMore(pageRecords.length === PAGE_SIZE);
    setAccumulatedRecords((prev) => {
      const map = new Map<string, ReengagementTouchRecord>();
      for (const record of prev) map.set(record.touch_key, record);
      for (const record of pageRecords) map.set(record.touch_key, record);
      return Array.from(map.values());
    });
    // filterKey 变化时也需要重新合并（React Query 命中缓存时 pageRecords 引用可能不变）
  }, [pageRecords, filterKey]);

  // 候选人视角累加：按 sessionId 覆盖去重，保持最新活动倒序
  useEffect(() => {
    if (!candidatePageData) return;
    setCandidatesHasMore(
      (candidatePage - 1) * CANDIDATE_PAGE_SIZE + candidatePageData.candidates.length <
        candidatePageData.total,
    );
    setAccumulatedCandidates((prev) => {
      const map = new Map<string, ReengagementCandidateSummary>();
      for (const candidate of prev) map.set(candidate.sessionId, candidate);
      for (const candidate of candidatePageData.candidates) map.set(candidate.sessionId, candidate);
      return Array.from(map.values()).sort(
        (a, b) => toTimestamp(b.latestAt) - toTimestamp(a.latestAt),
      );
    });
  }, [candidatePageData, candidatePage, filterKey]);

  // 按创建时间倒序渲染
  const records = useMemo(
    () =>
      [...accumulatedRecords].sort((a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at)),
    [accumulatedRecords],
  );

  const isCandidateView = viewMode === 'candidates';
  const isLoading = isCandidateView
    ? candidatesLoading && accumulatedCandidates.length === 0
    : pageLoading && records.length === 0;
  const isLoadingMore = isCandidateView
    ? candidatesLoading && candidatePage > 1
    : pageLoading && page > 1;

  const handleLoadMore = useCallback(() => {
    if (isCandidateView) {
      if (!candidatesLoading) setCandidatePage((prev) => prev + 1);
      return;
    }
    if (!pageLoading) {
      setPage((prev) => prev + 1);
    }
  }, [isCandidateView, candidatesLoading, pageLoading]);

  const scrollLength = isCandidateView ? accumulatedCandidates.length : records.length;
  const scrollHasMore = isCandidateView ? candidatesHasMore : hasMore;

  return (
    <div id="page-reengagement" className="page-section active">
      <ControlPanel
        stats={stats}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        timeRange={timeRange}
        onTimeRangeChange={handleTimeRangeChange}
        statusFilter={statusFilter}
        onStatusFilterChange={handleStatusFilterChange}
        scenarioFilter={scenarioFilter}
        onScenarioFilterChange={handleScenarioFilterChange}
        searchSessionId={searchSessionId}
        onSearchSessionIdChange={handleSearchSessionIdChange}
        pendingOnly={pendingOnly}
        onPendingOnlyChange={handlePendingOnlyChange}
        allValue={ALL_VALUE}
        scenarioOptions={scenarioOptions}
      />

      <InfiniteScroll
        dataLength={scrollLength}
        next={handleLoadMore}
        hasMore={scrollHasMore && scrollLength > 0}
        loader={
          isLoadingMore ? (
            <div
              style={{
                padding: '24px 20px',
                textAlign: 'center',
                color: '#94a3b8',
                fontSize: '13px',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: '16px',
                  height: '16px',
                  border: '2px solid rgba(99, 102, 241, 0.15)',
                  borderTopColor: '#6366f1',
                  borderRadius: '50%',
                  animation: 'spin 0.6s linear infinite',
                }}
              />
              加载更多...
            </div>
          ) : null
        }
        endMessage={
          scrollLength > 0 ? (
            <div
              style={{
                padding: '24px 20px',
                textAlign: 'center',
                color: '#94a3b8',
                fontSize: '13px',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
              }}
            >
              <span style={{ color: '#c7d2fe' }}>—</span>
              {isCandidateView
                ? `已加载全部 ${scrollLength} 个候选人`
                : `已加载全部 ${scrollLength} 条触达记录`}
              <span style={{ color: '#c7d2fe' }}>—</span>
            </div>
          ) : null
        }
      >
        {isCandidateView ? (
          <CandidateTable
            data={accumulatedCandidates}
            loading={isLoading}
            error={candidatesError && accumulatedCandidates.length === 0}
            scenarioLabels={scenarioLabels}
            onTouchClick={(touchKey) => setSelectedTouchKey(touchKey)}
          />
        ) : (
          <ReengagementTable
            data={records}
            loading={isLoading}
            error={pageError && records.length === 0}
            scenarioLabels={scenarioLabels}
            onRowClick={(record: ReengagementTouchRecord) =>
              setSelectedTouchKey(record.touch_key || null)
            }
          />
        )}
      </InfiniteScroll>

      {selectedTouchKey && (
        <ReengagementDetailDrawer
          touchKey={selectedTouchKey}
          scenarioLabels={scenarioLabels}
          onClose={() => setSelectedTouchKey(null)}
        />
      )}
    </div>
  );
}
