import { useState, useMemo } from 'react';
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
import {
  useChatSessionsOptimized,
  useChatSessionMessages,
  useChatDailyStats,
  useChatSummaryStats,
} from '@/hooks/chat/useChatSessions';
import { THEME_COLORS } from '@/constants';

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
  // 状态
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [timeRangeIndex, setTimeRangeIndex] = useState<number>(0);
  const [analyticsMonthIndex, setAnalyticsMonthIndex] = useState<number>(0);

  // 根据时间范围获取会话列表数据
  const currentRange = TIME_RANGE_OPTIONS[timeRangeIndex];
  const { startDate, endDate } = getDateRange(currentRange.days);

  // 根据月度选项获取数据分析数据
  const currentMonthOption = ANALYTICS_MONTH_OPTIONS[analyticsMonthIndex];
  const { startDate: analyticsStartDate, endDate: analyticsEndDate } = getMonthDateRange(
    currentMonthOption.months,
  );

  // API 请求 - 会话列表（优化版，使用数据库聚合）
  const { data: sessionsData, isLoading: sessionsLoading } = useChatSessionsOptimized(
    startDate,
    endDate,
  );

  // API 请求 - 顶部统计数据（使用聚合查询，性能优化）
  const { data: summaryStatsData } = useChatSummaryStats(startDate, endDate);

  // API 请求 - 数据分析（使用聚合查询，性能优化）
  const { data: dailyStatsData, isLoading: analyticsLoading } = useChatDailyStats(
    analyticsStartDate,
    analyticsEndDate,
  );
  const { data: messagesData, isLoading: messagesLoading } = useChatSessionMessages(selectedChatId);

  const sessions = sessionsData?.sessions || [];
  const dailyStats = dailyStatsData || [];
  const messages = messagesData?.messages || [];

  // 获取当前选中的会话详情
  const currentSession = useMemo(
    () => sessions.find((s) => s.chatId === selectedChatId),
    [sessions, selectedChatId],
  );

  // 会话列表统计数据（从数据库聚合查询获取）
  const sessionStats = summaryStatsData || {
    totalSessions: 0,
    totalMessages: 0,
    activeSessions: 0,
  };

  // 计算数据分析统计数据（从聚合结果中计算）
  const analyticsStats = useMemo(() => {
    return {
      totalSessions: dailyStats.reduce((acc, day) => acc + day.sessionCount, 0),
      totalMessages: dailyStats.reduce((acc, day) => acc + day.messageCount, 0),
    };
  }, [dailyStats]);

  // 基于数据库聚合结果计算趋势图数据
  const dailyTrendData = useMemo(() => {
    if (dailyStats.length === 0) return null;

    // 格式化日期为 "月/日" 格式
    const formattedData = dailyStats.map((stat) => {
      const date = new Date(stat.date);
      const dateKey = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      return {
        date: dateKey,
        messages: stat.messageCount,
        sessions: stat.sessionCount,
      };
    });

    return {
      labels: formattedData.map((d) => d.date),
      datasets: [
        {
          label: '消息数',
          data: formattedData.map((d) => d.messages),
          borderColor: THEME_COLORS.primary,
          backgroundColor: THEME_COLORS.primary10,
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: THEME_COLORS.primary,
        },
        {
          label: '会话数',
          data: formattedData.map((d) => d.sessions),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: '#10b981',
        },
      ],
    };
  }, [dailyStats]);

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

  const handleTimeRangeChange = (index: number) => {
    setTimeRangeIndex(index);
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
      />

      {/* 可展开的数据分析面板 */}
      <AnalyticsPanel
        show={showAnalytics}
        monthOptions={ANALYTICS_MONTH_OPTIONS}
        monthIndex={analyticsMonthIndex}
        onMonthChange={setAnalyticsMonthIndex}
        stats={analyticsStats}
        chartData={dailyTrendData}
        chartOptions={chartOptions}
        isLoading={analyticsLoading}
      />

      {/* 会话列表主体 */}
      <div className={styles.chatLayout}>
        {/* 左侧会话列表 */}
        <SessionList
          sessions={sessions}
          selectedChatId={selectedChatId}
          onSelectChat={setSelectedChatId}
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          isLoading={sessionsLoading}
          timeRangeLabel={currentRange.label}
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
