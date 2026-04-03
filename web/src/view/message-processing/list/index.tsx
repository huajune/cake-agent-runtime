import { useState, useMemo, useCallback, useEffect } from 'react';
import InfiniteScroll from 'react-infinite-scroll-component';
import {
  useMessageProcessingRecords,
  useMessageStats,
  useSlowestMessages,
} from '@/hooks/chat/useMessageProcessingRecords';
import ControlPanel from './components/ControlPanel';
import MessageProcessingTable from './components/MessageProcessingTable';
import MessageProcessingDetailDrawer from './components/MessageProcessingDetailDrawer';
import type { MessageRecord } from '@/api/types/chat.types';

export default function MessageProcessingPage() {
  const [timeRange, setTimeRange] = useState<'today' | 'week' | 'month'>('today');
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'realtime' | 'slowest'>('realtime');
  const [searchUserName, setSearchUserName] = useState<string>('');

  // 分页状态（仅用于实时列表）
  const [page, setPage] = useState(1);
  const [accumulatedMessages, setAccumulatedMessages] = useState<MessageRecord[]>([]);
  const PAGE_SIZE = 50;

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

  // 时间范围变化时重置分页和累加数据
  const handleTimeRangeChange = useCallback((newRange: 'today' | 'week' | 'month') => {
    setTimeRange(newRange);
    setPage(1);
    setAccumulatedMessages([]);
  }, []);

  // 用户搜索变化时重置分页和累加数据
  const handleSearchUserNameChange = useCallback((userName: string) => {
    setSearchUserName(userName);
    setPage(1);
    setAccumulatedMessages([]);
  }, []);

  // 统计数据：使用轻量级聚合查询接口
  const { data: statsData } = useMessageStats({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
  });

  const stats = statsData || { total: 0, success: 0, failed: 0, avgDuration: 0 };

  // 实时列表：支持分页（后端已排序）
  const { data: realtimeMessages, isLoading: realtimeLoading } = useMessageProcessingRecords({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    userName: searchUserName || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    enabled: activeTab === 'realtime',
  });

  // 当拉取到新数据时，累加到列表中
  useEffect(() => {
    if (realtimeMessages && realtimeMessages.length > 0) {
      if (page === 1) {
        // 第一页：替换数据
        setAccumulatedMessages(realtimeMessages);
      } else {
        // 后续页：累加数据（去重）
        setAccumulatedMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.messageId));
          const newMessages = realtimeMessages.filter((m) => !existingIds.has(m.messageId));
          return [...prev, ...newMessages];
        });
      }
    } else if (page === 1 && realtimeMessages) {
      // 第一页且无数据，清空
      setAccumulatedMessages([]);
    }
  }, [realtimeMessages, page]);

  // 最慢 Top10：使用专用接口（后端按 ai_duration 排序）
  const { data: slowestMessages, isLoading: slowestLoading } = useSlowestMessages({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    limit: 10,
    enabled: activeTab === 'slowest',
  });

  // 根据 Tab 切换数据源
  const messages = activeTab === 'realtime' ? accumulatedMessages : slowestMessages || [];
  const isLoading = activeTab === 'realtime' ? realtimeLoading && page === 1 : slowestLoading;
  const isLoadingMore = activeTab === 'realtime' && realtimeLoading && page > 1;

  // 是否还有更多数据（仅用于实时列表）
  const hasMore =
    activeTab === 'realtime' &&
    accumulatedMessages.length > 0 &&
    accumulatedMessages.length < stats.total;

  // 加载更多
  const handleLoadMore = useCallback(() => {
    if (!realtimeLoading) {
      setPage((prev) => prev + 1);
    }
  }, [realtimeLoading]);

  // Tab 数据量
  const realtimeCount = stats.total; // 使用统计数据的总数
  const slowestCount = slowestMessages?.length || 0;

  return (
    <div id="page-message-processing" className="page-section active">
      <ControlPanel
        stats={stats}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        realtimeCount={realtimeCount}
        slowestCount={slowestCount}
        timeRange={timeRange}
        onTimeRangeChange={handleTimeRangeChange}
        searchUserName={searchUserName}
        onSearchUserNameChange={handleSearchUserNameChange}
      />

      {/* 最慢Top10不需要无限滚动 */}
      {activeTab === 'slowest' ? (
        <MessageProcessingTable
          data={messages}
          loading={isLoading}
          onRowClick={(message: MessageRecord) => setSelectedMessageId(message.messageId || null)}
          variant={activeTab}
        />
      ) : (
        /* 实时列表使用无限滚动 */
        <InfiniteScroll
          dataLength={accumulatedMessages.length}
          next={handleLoadMore}
          hasMore={hasMore}
          loader={
            isLoadingMore ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                加载中...
              </div>
            ) : null
          }
          endMessage={
            accumulatedMessages.length > 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                已加载全部 {stats.total} 条记录
              </div>
            ) : null
          }
        >
          <MessageProcessingTable
            data={messages}
            loading={isLoading}
            onRowClick={(message: MessageRecord) => setSelectedMessageId(message.messageId || null)}
            variant={activeTab}
          />
        </InfiniteScroll>
      )}

      {selectedMessageId && (
        <MessageProcessingDetailDrawer
          messageId={selectedMessageId}
          onClose={() => setSelectedMessageId(null)}
        />
      )}
    </div>
  );
}
