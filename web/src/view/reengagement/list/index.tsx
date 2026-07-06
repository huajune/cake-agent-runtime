import { useState, useMemo, useCallback, useEffect } from 'react';
import InfiniteScroll from 'react-infinite-scroll-component';
import {
  useReengagementRecords,
  useReengagementStats,
} from '@/hooks/reengagement/useReengagementRecords';
import ControlPanel from './components/ControlPanel';
import ReengagementTable from './components/ReengagementTable';
import ReengagementDetailDrawer from './components/ReengagementDetailDrawer';
import type { ReengagementTouchRecord } from '@/api/types/reengagement.types';

const ALL_VALUE = '__all__';
const PAGE_SIZE = 50;

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function ReengagementPage() {
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('week');
  const [statusFilter, setStatusFilter] = useState<string>(ALL_VALUE);
  const [scenarioFilter, setScenarioFilter] = useState<string>(ALL_VALUE);
  const [searchSessionId, setSearchSessionId] = useState<string>('');
  const [selectedTouchKey, setSelectedTouchKey] = useState<string | null>(null);

  // 分页状态：offset 分页 + 无限滚动累加
  const [page, setPage] = useState(1);
  const [accumulatedRecords, setAccumulatedRecords] = useState<ReengagementTouchRecord[]>([]);
  const [hasMore, setHasMore] = useState(true);

  // 计算时间范围
  const dateRange = useMemo(() => {
    const now = new Date();
    const endDate = now.toISOString().split('T')[0];
    let startDate: string;

    if (timeRange === 'today') {
      startDate = endDate;
    } else if (timeRange === 'week') {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      startDate = weekAgo.toISOString().split('T')[0];
    } else {
      const monthAgo = new Date(now);
      monthAgo.setDate(monthAgo.getDate() - 30);
      startDate = monthAgo.toISOString().split('T')[0];
    }

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
  }, []);

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

  // 当前页数据
  const { data: pageRecords, isLoading: pageLoading } = useReengagementRecords({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    status: activeStatus,
    scenarioCode: activeScenario,
    sessionId: activeSessionId,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
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

  // 按创建时间倒序渲染
  const records = useMemo(
    () =>
      [...accumulatedRecords].sort((a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at)),
    [accumulatedRecords],
  );

  const isLoading = pageLoading && records.length === 0;
  const isLoadingMore = pageLoading && page > 1;

  const handleLoadMore = useCallback(() => {
    if (!pageLoading) {
      setPage((prev) => prev + 1);
    }
  }, [pageLoading]);

  return (
    <div id="page-reengagement" className="page-section active">
      <ControlPanel
        stats={stats}
        timeRange={timeRange}
        onTimeRangeChange={handleTimeRangeChange}
        statusFilter={statusFilter}
        onStatusFilterChange={handleStatusFilterChange}
        scenarioFilter={scenarioFilter}
        onScenarioFilterChange={handleScenarioFilterChange}
        searchSessionId={searchSessionId}
        onSearchSessionIdChange={handleSearchSessionIdChange}
        allValue={ALL_VALUE}
      />

      <InfiniteScroll
        dataLength={records.length}
        next={handleLoadMore}
        hasMore={hasMore && records.length > 0}
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
          records.length > 0 ? (
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
              已加载全部 {records.length} 条触达记录
              <span style={{ color: '#c7d2fe' }}>—</span>
            </div>
          ) : null
        }
      >
        <ReengagementTable
          data={records}
          loading={isLoading}
          onRowClick={(record: ReengagementTouchRecord) =>
            setSelectedTouchKey(record.touch_key || null)
          }
        />
      </InfiniteScroll>

      {selectedTouchKey && (
        <ReengagementDetailDrawer
          touchKey={selectedTouchKey}
          onClose={() => setSelectedTouchKey(null)}
        />
      )}
    </div>
  );
}
