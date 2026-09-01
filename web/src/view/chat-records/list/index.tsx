import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import type { ChartData } from 'chart.js';
import {
  useChatSessionsOptimized,
  useChatSessionMessages,
  useChatDailyStats,
  useChatSummaryStats,
} from '@/hooks/chat/useChatSessions';
import type { ChatSession } from '@/hooks/chat/useChatSessions';
import { useRealtimeChatRecords } from '@/hooks/chat/useRealtimeChatRecords';
import { THEME_COLORS } from '@/constants';
import { formatLocaleDate } from '@/utils/format';
import { isWeekendDate } from '@/utils/date-range';

// 组件导入
import HeaderBar from './components/HeaderBar';
import AnalyticsPanel from './components/AnalyticsPanel';
import SessionList from './components/SessionList';
import MessageDetail from './components/MessageDetail';

// 样式导入
import styles from './styles/index.module.scss';

// 注册 Chart.js 组件
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

// 会话列表时间范围选项配置
const TIME_RANGE_OPTIONS = [
  { value: 0, label: '今天', days: 0 },
  { value: 1, label: '近 3 天', days: 3 },
  { value: 2, label: '近 7 天', days: 7 },
  { value: 3, label: '近 30 天', days: 30 },
];

// 搜索防抖：搜索下推到服务端，避免每次击键都打一次库
const SEARCH_DEBOUNCE_MS = 350;

// 数据分析月度选项配置
const ANALYTICS_MONTH_OPTIONS = [
  { value: 0, label: '近 1 月', months: 1 },
  { value: 1, label: '近 2 月', months: 2 },
  { value: 2, label: '近 3 月', months: 3 },
];

// 获取月度日期范围
function getMonthDateRange(months: number): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = getDateString(now);

  // 使用 setMonth 而非 days * 30 近似，确保 "3个月" 精确回退到 3 个自然月前
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - months);

  return { startDate: getDateString(startDate), endDate };
}

// 获取日期字符串 (YYYY-MM-DD)
function getDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

// 把 'YYYY-MM-DD' 解析为本地时区当天零点。
// 不能用 new Date(dateStr)：那会按 UTC 零点解析，在负时区偏移下判成前一天，周末会判错。
function parseDateKey(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

// 计算时间范围
function getDateRange(days: number): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = getDateString(now);

  if (days === 0) {
    return { startDate: endDate, endDate };
  }

  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days + 1);
  return { startDate: getDateString(startDate), endDate };
}

export default function ChatRecords() {
  const [searchParams] = useSearchParams();
  const deepLinkChatId = searchParams.get('chatId');
  // 状态
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(deepLinkChatId);
  // 用户尚未手动选择会话时，右侧默认联动「最新产生消息」的候选人（列表已按消息时间倒序，取第一条）
  const [autoFollowLatest, setAutoFollowLatest] = useState(!deepLinkChatId);
  const [searchTerm, setSearchTerm] = useState('');
  // 搜索下推到服务端，防抖避免每次击键都打一次库
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('');
  const [timeRangeIndex, setTimeRangeIndex] = useState<number>(0);
  const [analyticsMonthIndex, setAnalyticsMonthIndex] = useState<number>(0);

  // Supabase Realtime：chat_messages 变更时自动刷新数据，并标记刚收到消息的会话
  const { isLive, activeChatIds } = useRealtimeChatRecords();

  // 根据时间范围获取会话列表数据
  const currentRange = TIME_RANGE_OPTIONS[timeRangeIndex];
  const { startDate, endDate } = getDateRange(currentRange.days);

  // 根据月度选项获取数据分析数据
  const currentMonthOption = ANALYTICS_MONTH_OPTIONS[analyticsMonthIndex];
  const { startDate: analyticsStartDate, endDate: analyticsEndDate } = getMonthDateRange(
    currentMonthOption.months,
  );

  // API 请求 - 会话列表（游标分页 + 服务端搜索）
  const {
    data: sessionsData,
    isLoading: sessionsLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useChatSessionsOptimized(startDate, endDate, true, debouncedSearchTerm);

  // API 请求 - 顶部统计数据（使用聚合查询，性能优化）
  const { data: summaryStatsData } = useChatSummaryStats(startDate, endDate);

  // API 请求 - 数据分析（使用聚合查询，性能优化）
  const { data: dailyStatsData, isLoading: analyticsLoading } = useChatDailyStats(
    analyticsStartDate,
    analyticsEndDate,
  );
  const { data: messagesData, isLoading: messagesLoading } = useChatSessionMessages(selectedChatId);

  // 展平分页结果；会话上浮到列表头时可能与历史页重复，按 chatId 去重保留最靠前的一条
  const sessions = useMemo(() => {
    const seen = new Set<string>();
    const flat: ChatSession[] = [];
    for (const page of sessionsData?.pages ?? []) {
      for (const session of page.sessions) {
        if (seen.has(session.chatId)) continue;
        seen.add(session.chatId);
        flat.push(session);
      }
    }
    return flat;
  }, [sessionsData]);
  const totalSessionCount = sessionsData?.pages?.[0]?.total ?? 0;
  const dailyStats = dailyStatsData || [];
  const messages = messagesData?.messages || [];

  // 获取当前选中的会话详情
  const currentSession = useMemo(
    () => sessions.find((s) => s.chatId === selectedChatId),
    [sessions, selectedChatId],
  );

  // 列表第一条即「最新产生消息」的候选人（后端按 timestamp DESC 排序）
  const latestChatId = sessions[0]?.chatId ?? null;

  useEffect(() => {
    if (!deepLinkChatId) return;
    setAutoFollowLatest(false);
    setSelectedChatId(deepLinkChatId);
  }, [deepLinkChatId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchTerm(searchTerm), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // 首次打开 / 切换时间范围且用户未手动选择时，自动选中最新消息的候选人
  useEffect(() => {
    if (autoFollowLatest && latestChatId) {
      setSelectedChatId(latestChatId);
    }
  }, [autoFollowLatest, latestChatId]);

  // 会话列表统计数据（从数据库聚合查询获取）
  const sessionStats = summaryStatsData || {
    totalSessions: 0,
    totalMessages: 0,
    activeSessions: 0,
  };

  // 只保留工作日：周六/周日几乎无招聘咨询，留在图上会把折线拉到零、淹没工作日趋势。
  // 与「托管趋势」图口径一致——剔除后的数据同时用于折线和右上角汇总。
  const businessDayStats = useMemo(
    () => dailyStats.filter((stat) => !isWeekendDate(parseDateKey(stat.date))),
    [dailyStats],
  );

  // 计算数据分析统计数据（从聚合结果中计算）
  const analyticsStats = useMemo(() => {
    return {
      totalSessions: businessDayStats.reduce((acc, day) => acc + day.sessionCount, 0),
      totalMessages: businessDayStats.reduce((acc, day) => acc + day.messageCount, 0),
    };
  }, [businessDayStats]);

  // 基于数据库聚合结果计算趋势图数据（会话数 / 消息数 拆成两张图）
  const trendCharts = useMemo(() => {
    if (businessDayStats.length === 0) return null;

    // 格式化日期为 "月/日" 格式
    const formattedData = businessDayStats.map((stat) => {
      const dateKey = formatLocaleDate(parseDateKey(stat.date), {
        month: 'numeric',
        day: 'numeric',
      });
      return {
        date: dateKey,
        messages: stat.messageCount,
        sessions: stat.sessionCount,
      };
    });

    const labels = formattedData.map((d) => d.date);
    const baseDataset = { fill: true, tension: 0.4, pointRadius: 4, pointHoverRadius: 6 };

    return {
      sessions: {
        labels,
        datasets: [
          {
            label: '会话数',
            data: formattedData.map((d) => d.sessions),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            pointBackgroundColor: '#10b981',
            ...baseDataset,
          },
        ],
      } as ChartData<'line'>,
      messages: {
        labels,
        datasets: [
          {
            label: '消息数',
            data: formattedData.map((d) => d.messages),
            borderColor: THEME_COLORS.primary,
            backgroundColor: THEME_COLORS.primary10,
            pointBackgroundColor: THEME_COLORS.primary,
            ...baseDataset,
          },
        ],
      } as ChartData<'line'>,
    };
  }, [businessDayStats]);

  // Chart.js 配置
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        mode: 'index' as const,
        intersect: false,
        backgroundColor: 'rgba(255, 255, 255, 0.98)',
        titleColor: '#1f2937',
        bodyColor: '#4b5563',
        borderColor: '#e5e7eb',
        borderWidth: 1,
        padding: 12,
        boxPadding: 6,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
      },
      y: {
        grid: { color: 'rgba(0,0,0,0.04)' },
        beginAtZero: true,
        ticks: { font: { size: 11 } },
      },
    },
    interaction: {
      mode: 'nearest' as const,
      axis: 'x' as const,
      intersect: false,
    },
  };

  // 用户手动选择会话后，停止自动联动最新消息
  const handleSelectChat = (chatId: string) => {
    setAutoFollowLatest(false);
    setSelectedChatId(chatId);
  };

  const handleTimeRangeChange = (index: number) => {
    setTimeRangeIndex(index);
    // 切换时间范围视为重新进入，恢复默认联动最新消息
    setAutoFollowLatest(true);
    setSelectedChatId(null);
  };

  return (
    <div className={styles.page}>
      {/* 统一操作栏 */}
      <HeaderBar
        timeRangeOptions={TIME_RANGE_OPTIONS}
        timeRangeIndex={timeRangeIndex}
        onTimeRangeChange={handleTimeRangeChange}
        sessionStats={sessionStats}
        showAnalytics={showAnalytics}
        onToggleAnalytics={() => setShowAnalytics(!showAnalytics)}
        isLive={isLive}
      />

      {/* 可展开的数据分析面板（顶部「消息趋势」按钮控制，默认折叠） */}
      <AnalyticsPanel
        show={showAnalytics}
        monthOptions={ANALYTICS_MONTH_OPTIONS}
        monthIndex={analyticsMonthIndex}
        onMonthChange={setAnalyticsMonthIndex}
        stats={analyticsStats}
        sessionsChartData={trendCharts?.sessions ?? null}
        messagesChartData={trendCharts?.messages ?? null}
        chartOptions={chartOptions}
        isLoading={analyticsLoading}
      />

      {/* 会话列表主体 */}
      <div className={styles.chatLayout}>
        {/* 左侧会话列表 */}
        <SessionList
          sessions={sessions}
          selectedChatId={selectedChatId}
          onSelectChat={handleSelectChat}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          isLoading={sessionsLoading}
          timeRangeLabel={currentRange.label}
          activeChatIds={activeChatIds}
          total={totalSessionCount}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={fetchNextPage}
        />

        {/* 右侧消息详情 */}
        <MessageDetail
          selectedChatId={selectedChatId}
          messages={messages}
          currentSession={currentSession}
          isLoading={messagesLoading}
        />
      </div>
    </div>
  );
}
