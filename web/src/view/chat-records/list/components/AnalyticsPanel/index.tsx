import { Line } from 'react-chartjs-2';
import type { ChartData, ChartOptions } from 'chart.js';
import styles from './index.module.scss';

interface MonthOption {
  value: number;
  label: string;
  months: number;
}

interface AnalyticsPanelProps {
  show: boolean;
  monthOptions: MonthOption[];
  monthIndex: number;
  onMonthChange: (index: number) => void;
  stats: {
    totalSessions: number;
    totalMessages: number;
  };
  sessionsChartData: ChartData<'line'> | null;
  messagesChartData: ChartData<'line'> | null;
  chartOptions: ChartOptions<'line'>;
  isLoading: boolean;
}

export default function AnalyticsPanel({
  show,
  monthOptions,
  monthIndex,
  onMonthChange,
  stats,
  sessionsChartData,
  messagesChartData,
  chartOptions,
  isLoading,
}: AnalyticsPanelProps) {
  const renderChart = (chartData: ChartData<'line'> | null) =>
    chartData ? (
      <Line data={chartData} options={chartOptions} />
    ) : (
      <div className={styles.emptyState}>
        {isLoading ? <div className="loading-spinner"></div> : '暂无趋势数据'}
      </div>
    );

  return (
    <div className={`${styles.panelWrapper} ${show ? styles.show : ''}`}>
      <div className={styles.panel}>
        {/* 分析面板头部 */}
        <div className={styles.header}>
          {/* 左侧：月度选择器 */}
          <div className={styles.leftSection}>
            <span className={styles.title}>消息趋势</span>
            <div className={styles.filters}>
              {monthOptions.map((option, index) => (
                <button
                  key={option.value}
                  className={`${styles.filterBtn} ${monthIndex === index ? styles.active : ''}`}
                  onClick={() => onMonthChange(index)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* 右侧：统计 */}
          <div className={styles.rightSection}>
            <div className={styles.stats}>
              <span className={styles.statItem}>
                <span>会话 </span>
                <span className={styles.success}>{stats.totalSessions}</span>
              </span>
              <span className={styles.statItem}>
                <span>消息 </span>
                <span className={styles.primary}>{stats.totalMessages}</span>
              </span>
            </div>
          </div>
        </div>

        {/* 图表：会话数 / 消息数 分开两张 */}
        <div className={styles.chartsRow}>
          <div className={styles.chartItem}>
            <div className={styles.chartCaption}>
              <span className={`${styles.legendDot} ${styles.success}`} />
              <span>会话数</span>
            </div>
            <div className={styles.chartContainer}>{renderChart(sessionsChartData)}</div>
          </div>
          <div className={styles.chartItem}>
            <div className={styles.chartCaption}>
              <span className={`${styles.legendDot} ${styles.primary}`} />
              <span>消息数</span>
            </div>
            <div className={styles.chartContainer}>{renderChart(messagesChartData)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
