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
  chartData: ChartData<'line'> | null;
  chartOptions: ChartOptions<'line'>;
  isLoading: boolean;
}

export default function AnalyticsPanel({
  show,
  monthOptions,
  monthIndex,
  onMonthChange,
  stats,
  chartData,
  chartOptions,
  isLoading,
}: AnalyticsPanelProps) {
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

          {/* 右侧：统计 + 图例 */}
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
            <div className={styles.divider} />
            <div className={styles.legend}>
              <span className={styles.legendItem}>
                <span className={`${styles.legendDot} ${styles.success}`} />
                会话数
              </span>
              <span className={styles.legendItem}>
                <span className={`${styles.legendDot} ${styles.primary}`} />
                消息数
              </span>
            </div>
          </div>
        </div>

        {/* 图表 */}
        <div className={styles.chartContainer}>
          {chartData ? (
            <Line data={chartData} options={chartOptions} />
          ) : (
            <div className={styles.emptyState}>
              {isLoading ? <div className="loading-spinner"></div> : '暂无趋势数据'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
