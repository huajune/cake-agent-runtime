import { useState, useEffect } from 'react';
import { Line, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { useDashboardOverview } from '@/hooks/analytics/useDashboard';
import { useHealthStatus } from '@/hooks/analytics/useMetrics';
import { useWorkerStatus } from '@/hooks/config/useWorker';
import type { DashboardTimeRange } from '@/api/types/analytics.types';
import { formatDuration, formatMinuteLabel, formatDayLabel, formatHourLabel } from '@/utils/format';
import { buildRecentBusinessDateRange, formatDateKey } from '@/utils/date-range';
import { THEME_COLORS } from '@/constants';

// 组件导入
import ControlPanel from './components/ControlPanel';
import HealthGrid from './components/HealthGrid';
import MetricCard, { MetricGrid } from './components/MetricCard';
import ChartCard, { ChartsRow } from './components/ChartCard';

// 样式导入
import styles from './styles/index.module.scss';

// 春日装饰 emoji 列表
const springDecorations = ['🌿', '🍃', '🌱', '🌾', '🐦', '🐝', '🌻', '🌼', '🍀', '🌳'];

const TIME_RANGE_LABELS: Record<DashboardTimeRange, string> = {
  today: '本日',
  week: '近7天',
  month: '近30天',
  twoMonths: '近2月',
  threeMonths: '近3月',
};

const COMPARISON_LABELS: Record<DashboardTimeRange, string> = {
  today: '较昨日同期',
  week: '较前7天同期',
  month: '较前30天同期',
  twoMonths: '较前2月同期',
  threeMonths: '较前3月同期',
};

const RANGE_DAYS: Record<DashboardTimeRange, number> = {
  today: 1,
  week: 7,
  month: 30,
  twoMonths: 60,
  threeMonths: 90,
};

function buildDateRange(timeRange: DashboardTimeRange) {
  const days = RANGE_DAYS[timeRange];
  return buildRecentBusinessDateRange(days);
}

function toDateKey(value?: string) {
  if (!value) return '';

  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (match) {
    return match[0];
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateKey(date);
}

// 注册 Chart.js 组件
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

export default function Dashboard() {
  const [timeRange, setTimeRange] = useState<DashboardTimeRange>('today');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [groups, setGroups] = useState<string[]>([]);

  const {
    data: rawDashboard,
    isLoading: dashboardInitialLoading,
    isFetching: dashboardFetching,
    isPlaceholderData: dashboardPlaceholder,
    dataUpdatedAt,
  } = useDashboardOverview(timeRange, autoRefresh, groups);
  const dashboard = rawDashboard?.timeRange === timeRange ? rawDashboard : undefined;
  const dashboardLoading = dashboardInitialLoading || !dashboard;
  // 刷新/加载指示：初次加载（含整页刷新）或后台刷新（已有占位数据）时，顶部显示滑动进度条。
  const showRefreshBar = dashboardLoading || (dashboardFetching && dashboardPlaceholder);
  const { data: health } = useHealthStatus(autoRefresh);

  // 卡片装饰贴纸
  useEffect(() => {
    const cards = document.querySelectorAll('.metric-card, .chart-card, .insight-card');

    cards.forEach((card) => {
      card.querySelectorAll('.spring-sticker').forEach((s) => s.remove());

      if (Math.random() > 0.6) {
        const sticker = document.createElement('div');
        sticker.className = 'spring-sticker sticker-tr';
        sticker.textContent =
          springDecorations[Math.floor(Math.random() * springDecorations.length)];
        sticker.style.animationDelay = `${Math.random() * 2}s`;
        card.appendChild(sticker);
      }

      if (Math.random() > 0.85) {
        const sticker2 = document.createElement('div');
        sticker2.className = 'spring-sticker sticker-tl';
        sticker2.textContent =
          springDecorations[Math.floor(Math.random() * springDecorations.length)];
        card.appendChild(sticker2);
      }
    });

    return () => {
      document.querySelectorAll('.spring-sticker').forEach((s) => s.remove());
    };
  }, [dashboardLoading]);

  const { data: workerStatus } = useWorkerStatus(autoRefresh);

  const overview = dashboard?.overview;
  const overviewDelta = dashboard?.overviewDelta;
  const business = dashboard?.business;
  const businessDelta = dashboard?.businessDelta;

  const isToday = timeRange === 'today';
  const formatLabel = isToday ? formatMinuteLabel : formatDayLabel;
  const dateRange = isToday ? [] : buildDateRange(timeRange);
  const businessPoints = isToday
    ? (dashboard?.businessTrend || []).slice(-90)
    : dateRange.map((date) => {
        const point = (dashboard?.businessTrend || []).find((p) => toDateKey(p.minute) === date);
        return {
          minute: date,
          consultations: point?.consultations ?? 0,
          bookingAttempts: point?.bookingAttempts ?? 0,
          successfulBookings: point?.successfulBookings ?? 0,
          conversionRate: point?.conversionRate ?? 0,
          bookingSuccessRate: point?.bookingSuccessRate ?? 0,
        };
      });

  // 健康状态
  const healthStatus =
    health?.status === 'healthy' && health?.providers?.count > 0 && health?.tools?.total > 0
      ? 'healthy'
      : health?.status !== 'healthy'
        ? 'error'
        : 'warning';

  const healthMessage =
    healthStatus === 'healthy'
      ? '全部正常'
      : health?.status !== 'healthy'
        ? '服务异常'
        : health
          ? '部分异常'
          : '检查中...';

  // 图表配置
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        titleColor: '#1e293b',
        bodyColor: '#475569',
        borderColor: 'rgba(148, 163, 184, 0.2)',
        borderWidth: 1,
        padding: 12,
        cornerRadius: 8,
        displayColors: false,
      },
    },
    scales: {
      x: {
        display: true,
        grid: { display: false, drawBorder: true },
        border: { display: true },
        ticks: {
          display: true,
          color: '#94a3b8',
          font: { size: 11 },
          autoSkip: true,
          maxRotation: 0,
        },
      },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: 'rgba(0, 0, 0, 0.03)' },
        ticks: { color: '#94a3b8', font: { size: 11 }, padding: 10 },
      },
    },
    elements: {
      line: { tension: 0.4, borderWidth: 3 },
      point: { radius: 0, hoverRadius: 6, borderWidth: 2, hoverBorderWidth: 3 },
    },
  };

  // 托管用户趋势
  const consultationChartData = {
    labels: businessPoints.map((p) => formatLabel(p.minute)),
    datasets: [
      {
        label: '用户数',
        data: businessPoints.map((p) => p.consultations || 0),
        borderColor: THEME_COLORS.primary,
        backgroundColor: THEME_COLORS.primary20,
        fill: true,
        pointBackgroundColor: '#ffffff',
        pointBorderColor: THEME_COLORS.primary,
        pointRadius: 4,
        pointHoverRadius: 6,
      },
    ],
  };

  // 预约转化趋势
  const bookingChartData = {
    labels: businessPoints.map((p) => formatLabel(p.minute)),
    datasets: [
      {
        label: '预约成功数',
        data: businessPoints.map((p) => p.successfulBookings || p.bookingAttempts || 0),
        borderColor: THEME_COLORS.accent,
        backgroundColor: THEME_COLORS.accent20,
        fill: true,
        yAxisID: 'y',
        pointBackgroundColor: '#ffffff',
        pointBorderColor: THEME_COLORS.accent,
        pointRadius: 4,
        pointHoverRadius: 6,
      },
      {
        label: '咨询转化率',
        data: businessPoints.map((p) => p.conversionRate || 0),
        borderColor: '#10b981',
        backgroundColor: 'transparent',
        borderDash: [5, 5],
        fill: false,
        yAxisID: 'y1',
        pointBackgroundColor: '#ffffff',
        pointBorderColor: '#10b981',
        pointRadius: 4,
        pointHoverRadius: 6,
      },
    ],
  };

  const bookingChartOptions = {
    ...commonOptions,
    plugins: {
      ...commonOptions.plugins,
      legend: { display: true, labels: { color: '#6b7280', usePointStyle: true, boxWidth: 8 } },
    },
    scales: {
      x: commonOptions.scales.x,
      y: {
        ...commonOptions.scales.y,
        position: 'left' as const,
        title: {
          display: true,
          text: '预约成功数',
          color: THEME_COLORS.accent,
          font: { size: 10 },
        },
      },
      y1: {
        ...commonOptions.scales.y,
        position: 'right' as const,
        grid: { drawOnChartArea: false },
        ticks: { callback: (value: number | string) => `${value}%` },
        title: { display: true, text: '转化率 (%)', color: '#10b981', font: { size: 10 } },
      },
    },
  };

  // Token 消耗 - 本日显示小时级，其余范围显示天级
  const tokenPoints = isToday
    ? dashboard?.tokenTrend || []
    : dateRange.map((date) => {
        const point = (dashboard?.tokenTrend || []).find((p: any) => toDateKey(p.time) === date);
        return {
          time: date,
          tokenUsage: point?.tokenUsage ?? 0,
          messageCount: point?.messageCount ?? 0,
        };
      });
  const tokenChartData = {
    labels: tokenPoints.map((p: any) =>
      isToday ? formatHourLabel(p.time) : formatDayLabel(p.time),
    ),
    datasets: [
      {
        label: 'Token 消耗',
        data: tokenPoints.map((p: any) => p.tokenUsage),
        backgroundColor: '#f59e0b',
        borderRadius: 6,
        hoverBackgroundColor: '#d97706',
        barThickness: 'flex' as const,
        maxBarThickness: 32,
      },
    ],
  };

  // 响应耗时 - 本日显示分钟级，其余范围显示天级
  const responsePoints = isToday
    ? (dashboard?.responseTrend || []).slice(-60)
    : dateRange.map((date) => {
        const point = (dashboard?.responseTrend || []).find((p) => toDateKey(p.minute) === date);
        return {
          minute: date,
          avgDuration: point?.avgDuration ?? 0,
          messageCount: point?.messageCount ?? 0,
          successRate: point?.successRate ?? 0,
        };
      });
  const responseChartData = {
    labels: responsePoints.map((p) =>
      isToday ? formatMinuteLabel(p.minute) : formatDayLabel(p.minute),
    ),
    datasets: [
      {
        label: '平均耗时 (秒)',
        data: responsePoints.map((p) => (p.avgDuration ? p.avgDuration / 1000 : 0)),
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.2)',
        fill: true,
        tension: 0.4,
        borderWidth: 3,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointBackgroundColor: '#ffffff',
        pointBorderColor: '#06b6d4',
        pointBorderWidth: 2,
        pointHoverBorderWidth: 3,
      },
    ],
  };

  const timeRangeBadge = TIME_RANGE_LABELS[timeRange];
  const comparisonLabel = COMPARISON_LABELS[timeRange];
  const totalMessages = overview?.totalMessages ?? 0;
  const successCount = overview?.successCount ?? 0;
  const failureCount = overview?.failureCount ?? 0;
  const manualInterventionTotal = dashboard?.manualIntervention?.totalCount ?? 0;
  const handoffCount = dashboard?.manualIntervention?.handoffCount ?? 0;
  const riskAlertCount = dashboard?.manualIntervention?.riskAlertCount ?? 0;
  const managedUsers = business?.consultations?.total ?? 0;
  const successfulBookings = business?.bookings?.successful ?? 0;
  const hideEmptyDelta = (current: number, delta?: number) =>
    dashboardLoading || (current === 0 && Math.abs(delta ?? 0) < 0.05) ? undefined : delta;
  const requestSubtitle = dashboardLoading
    ? '加载中'
    : totalMessages > 0
      ? `成功 ${successCount} / 异常 ${failureCount}`
      : '暂无请求';
  const successRateSubtitle = dashboardLoading
    ? '加载中'
    : totalMessages > 0
      ? `成功 ${successCount} / 请求 ${totalMessages}`
      : '暂无请求';
  const responseSubtitle = dashboardLoading
    ? '加载中'
    : totalMessages > 0
      ? '按有效请求统计'
      : '暂无有效响应';
  const activeUserSubtitle = dashboardLoading
    ? '加载中'
    : (overview?.activeUsers ?? 0) > 0
      ? '近 1 小时有对话往来'
      : '近 1 小时暂无活跃';
  const manualInterventionSubtitle = dashboardLoading
    ? '加载中'
    : manualInterventionTotal > 0
      ? `转人工 ${handoffCount} / 风险 ${riskAlertCount}`
      : '暂无人工介入';
  const bookingSubtitle = dashboardLoading ? (
    <>加载中</>
  ) : successfulBookings > 0 ? (
    <>已记录成功预约</>
  ) : (
    <>暂无成功预约</>
  );
  const conversionSubtitle = dashboardLoading ? (
    <>加载中</>
  ) : managedUsers > 0 ? (
    <>
      预约成功 <span className="text-success">{successfulBookings}</span> / 托管用户{' '}
      <span>{managedUsers}</span>
    </>
  ) : (
    <>暂无托管用户</>
  );

  return (
    <div className={styles.page}>
      {showRefreshBar ? (
        <div
          className={styles.refreshBar}
          role="status"
          aria-live="polite"
          aria-label="正在加载数据"
        />
      ) : null}

      {/* 控制面板 */}
      <ControlPanel
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        groups={groups}
        onGroupsChange={setGroups}
        healthStatus={healthStatus}
        healthMessage={healthMessage}
        lastUpdate={dataUpdatedAt ?? null}
      >
        {/* 健康状态网格 */}
        <HealthGrid health={health} workerStatus={workerStatus} />
      </ControlPanel>

      {/* 核心指标 */}
      <MetricGrid>
        <MetricCard
          label="处理请求数"
          value={dashboardLoading ? '-' : totalMessages}
          subtitle={requestSubtitle}
          delta={hideEmptyDelta(totalMessages, overviewDelta?.totalMessages)}
          deltaLabel={comparisonLabel}
          variant="primary"
          timeRangeBadge={timeRangeBadge}
        />
        <MetricCard
          label="成功率"
          value={dashboardLoading ? '-' : `${(overview?.successRate ?? 0).toFixed(1)}%`}
          subtitle={successRateSubtitle}
          delta={hideEmptyDelta(totalMessages, overviewDelta?.successRate)}
          deltaLabel={comparisonLabel}
          deltaUnit="points"
          variant="success"
        />
        <MetricCard
          label="平均响应"
          value={dashboardLoading ? '-' : formatDuration(overview?.avgDuration ?? 0)}
          subtitle={responseSubtitle}
          delta={hideEmptyDelta(overview?.avgDuration ?? 0, overviewDelta?.avgDuration)}
          deltaLabel={comparisonLabel}
          deltaInverse
        />
        <MetricCard
          label="活跃用户"
          value={dashboardLoading ? '-' : (overview?.activeUsers ?? 0)}
          subtitle={activeUserSubtitle}
          timeRangeBadge="近1h"
        />
        <MetricCard
          label="人工介入触发次数"
          value={dashboardLoading ? '-' : manualInterventionTotal}
          subtitle={manualInterventionSubtitle}
          className="border-warning-soft"
        />
      </MetricGrid>

      {/* 业务指标 */}
      <MetricGrid columns={3}>
        <MetricCard
          label="托管用户数"
          value={dashboardLoading ? '-' : managedUsers}
          subtitle={<>独立用户，同一人仅算 1 个</>}
          delta={hideEmptyDelta(managedUsers, businessDelta?.consultations)}
          deltaLabel={comparisonLabel}
          timeRangeBadge={timeRangeBadge}
          className="border-primary-soft"
        />
        <MetricCard
          label="预约成功数"
          value={dashboardLoading ? '-' : successfulBookings}
          subtitle={bookingSubtitle}
          className="border-purple-soft"
        />
        <MetricCard
          label="咨询转化率"
          value={
            dashboardLoading
              ? '-'
              : `${(business?.conversion?.consultationToBooking ?? 0).toFixed(1)}%`
          }
          subtitle={conversionSubtitle}
          variant="success"
          className="border-success-soft"
        />
      </MetricGrid>

      {/* 趋势图表 */}
      <ChartsRow>
        <ChartCard title="托管用户趋势" subtitle="独立用户数">
          <Line
            data={consultationChartData}
            options={{
              ...commonOptions,
              scales: {
                ...commonOptions.scales,
                y: { ...commonOptions.scales.y, ticks: { stepSize: 1, precision: 0 } },
              },
            }}
          />
        </ChartCard>
        <ChartCard title="预约转化趋势" subtitle="预约成功数与咨询转化率">
          <Line data={bookingChartData} options={bookingChartOptions} />
        </ChartCard>
      </ChartsRow>

      {/* Token 消耗 & 响应耗时 */}
      <ChartsRow>
        <ChartCard
          title="Token 消耗"
          subtitle={isToday ? '今日每小时消耗' : `${timeRangeBadge}每日消耗`}
          kpiLabel={`${timeRangeBadge}总消耗`}
          kpiValue={
            tokenPoints.reduce((sum: number, p: any) => sum + (p.tokenUsage || 0), 0) || '-'
          }
        >
          <Bar data={tokenChartData} options={commonOptions} />
        </ChartCard>
        <ChartCard
          title="响应耗时"
          subtitle={isToday ? '今日平均响应时间' : `${timeRangeBadge}平均响应时间`}
          kpiLabel="当前平均"
          kpiValue={
            dashboard?.overview?.avgDuration ? formatDuration(dashboard.overview.avgDuration) : '-'
          }
        >
          <Line data={responseChartData} options={commonOptions} />
        </ChartCard>
      </ChartsRow>
    </div>
  );
}
