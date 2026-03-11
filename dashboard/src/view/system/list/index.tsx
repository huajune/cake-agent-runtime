import { useState, useEffect } from 'react';
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
  useAgentReplyConfig,
  useUpdateAgentReplyConfig,
} from '@/hooks/config/useSystemConfig';
import { useSystemMonitoring } from '@/hooks/analytics/useDashboard';
import { useMetrics } from '@/hooks/analytics/useMetrics';
import { formatDuration, formatHourLabel } from '@/utils/format';
import type { AgentReplyConfig } from '@/types/monitoring';

// 组件导入
import KpiCard, { KpiGrid } from './components/KpiCard';
import ConsolePanel from './components/ConsolePanel';

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
  Filler
);

export default function System() {
  const { data: configData } = useAgentReplyConfig();
  const updateConfig = useUpdateAgentReplyConfig();

  // 获取真实数据
  const { data: dashboard } = useSystemMonitoring();
  const { data: metrics } = useMetrics();

  // 告警配置本地状态
  const [alertConfig, setAlertConfig] = useState({
    businessAlertEnabled: true,
    minSamplesForAlert: 10,
    alertIntervalMinutes: 30,
    alertThrottleWindowMs: 300000,
    alertThrottleMaxCount: 3,
    // 告警阈值
    successRateCritical: 80,
    avgDurationCritical: 60000,
    queueDepthCritical: 20,
    errorRateCritical: 10,
  });

  // 同步配置数据
  useEffect(() => {
    if (configData?.config) {
      setAlertConfig({
        businessAlertEnabled: configData.config.businessAlertEnabled ?? true,
        minSamplesForAlert: configData.config.minSamplesForAlert ?? 10,
        alertIntervalMinutes: configData.config.alertIntervalMinutes ?? 30,
        alertThrottleWindowMs: configData.config.alertThrottleWindowMs ?? 300000,
        alertThrottleMaxCount: configData.config.alertThrottleMaxCount ?? 3,
        // 告警阈值
        successRateCritical: configData.config.successRateCritical ?? 80,
        avgDurationCritical: configData.config.avgDurationCritical ?? 60000,
        queueDepthCritical: configData.config.queueDepthCritical ?? 20,
        errorRateCritical: configData.config.errorRateCritical ?? 10,
      });
    }
  }, [configData]);

  // 从真实数据中提取
  const queue = dashboard?.queue;
  const alerts = dashboard?.alertsSummary;
  const percentiles = metrics?.percentiles;
  const recentAlertCount = alerts?.lastHour ?? null;
  const alertTrend = dashboard?.alertTrend ?? [];

  // 更新配置 - 只发送变更的字段
  const handleConfigChange = (key: keyof AgentReplyConfig, value: number | boolean) => {
    const newConfig = { ...alertConfig, [key]: value };
    setAlertConfig(newConfig);
    // 只发送变更的字段，减少数据传输
    updateConfig.mutate({ [key]: value });
  };

  // 切换告警开关
  const toggleAlert = () => {
    const newValue = !alertConfig.businessAlertEnabled;
    setAlertConfig((prev) => ({ ...prev, businessAlertEnabled: newValue }));
    updateConfig.mutate({ businessAlertEnabled: newValue });
  };

  // 错误趋势图表数据（24小时）
  const alertChartData = {
    labels: alertTrend.map((p) => formatHourLabel(p.minute)),
    datasets: [
      {
        label: '错误次数',
        data: alertTrend.map((p) => p.count || 0),
        borderColor: '#ef4444',
        backgroundColor: (context: { chart: { ctx: CanvasRenderingContext2D } }) => {
          const ctx = context.chart.ctx;
          const gradient = ctx.createLinearGradient(0, 0, 0, 300);
          gradient.addColorStop(0, 'rgba(239, 68, 68, 0.2)');
          gradient.addColorStop(1, 'rgba(239, 68, 68, 0)');
          return gradient;
        },
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.4,
      },
    ],
  };

  // 图表配置
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(255, 255, 255, 0.9)',
        titleColor: '#1f2937',
        bodyColor: '#6b7280',
        borderColor: 'rgba(0,0,0,0.05)',
        borderWidth: 1,
        padding: 12,
        boxPadding: 6,
        usePointStyle: true,
        displayColors: false,
        callbacks: {
          label: (context: { parsed: { y: number | null } }) => `${context.parsed.y ?? 0} 次错误`,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: '#94a3b8',
          font: { size: 10 },
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 12,
        },
      },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: 'rgba(0, 0, 0, 0.02)' },
        ticks: {
          color: '#94a3b8',
          font: { size: 10 },
          padding: 10,
          stepSize: 1,
        },
      },
    },
  };

  return (
    <div className={styles.page}>
      {/* KPI 卡片 */}
      <KpiGrid>
        <KpiCard
          icon="⚡️"
          variant="primary"
          label="实时处理"
          value={queue?.currentProcessing ?? '-'}
          valueVariant="primary"
          trend={{ direction: 'flat', value: '实时', label: '当前队列' }}
          title="当前正在处理的消息数量"
        />
        <KpiCard
          icon="⏱️"
          variant="warning"
          label="P95 延迟"
          value={percentiles?.p95 ? formatDuration(percentiles.p95) : '-'}
          valueVariant="warning"
          trend={{ direction: 'flat', value: '实时', label: '响应时间' }}
          title="95% 的请求在此时间内完成"
        />
        <KpiCard
          icon="🚨"
          variant="danger"
          label="今日错误"
          value={alerts?.total ?? '-'}
          valueVariant="danger"
          trend={{
            direction: (alerts?.lastHour ?? 0) > 0 ? 'up' : 'flat',
            value: `+${alerts?.lastHour ?? 0}`,
            label: '近1小时',
          }}
          title="今日消息处理错误总数（非飞书告警数）"
        />
        <KpiCard
          icon="🌊"
          variant="info"
          label="峰值队列"
          value={queue?.peakProcessing ?? '-'}
          trend={{ direction: 'flat', value: '今日', label: '最大积压' }}
          title="今日队列积压的最大数量"
        />
      </KpiGrid>

      {/* 控制台面板 */}
      <ConsolePanel
        alertConfig={alertConfig}
        onConfigChange={handleConfigChange}
        onToggleAlert={toggleAlert}
        isUpdating={updateConfig.isPending}
        chartData={alertChartData}
        chartOptions={chartOptions}
        recentAlertCount={recentAlertCount}
        alertTypes={alerts?.byType}
      />
    </div>
  );
}
