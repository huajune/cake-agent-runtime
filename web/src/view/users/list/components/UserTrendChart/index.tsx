import { useState } from 'react';
import { useUserTrend } from '@/hooks/user/useUsers';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Area, AreaChart } from 'recharts';
import { IconUsers, IconBarChart, IconFlame, IconTrend, IconEmpty, IconInfo } from '../Icons';
import { THEME_COLORS } from '@/constants';
import { USER_RANGE_OPTIONS } from '../../constants';
import styles from './index.module.scss';

type ChartDataItem = {
  date: string;
  fullDate: string;
  用户数: number;
  消息数: number;
};

type MetricKey = '用户数' | '消息数';

type MetricBoard = {
  title: string;
  subtitle: string;
  dataKey: MetricKey;
  color: string;
  gradientId: string;
  unit: string;
  totalUnit?: string;
  total: number;
  average: number;
  peak: number;
};

interface UserTrendChartProps {
  selectedDays: number;
  onSelectedDaysChange: (days: number) => void;
}

function parseDateKey(dateStr: string) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function buildDateRange(days: number) {
  const endDate = new Date();
  const startDate = addDays(endDate, -(days - 1));

  return Array.from({ length: days }, (_, index) => formatDateKey(addDays(startDate, index)));
}

export default function UserTrendChart({
  selectedDays,
  onSelectedDaysChange,
}: UserTrendChartProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data: trendData = [], isLoading } = useUserTrend(selectedDays);
  const selectedRange =
    USER_RANGE_OPTIONS.find((option) => option.days === selectedDays) || USER_RANGE_OPTIONS[0];

  // 格式化日期显示（MM-DD）
  const formatDate = (dateStr: string) => {
    const date = parseDateKey(dateStr);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;
  };

  const trendDataByDate = new Map(trendData.map((item) => [item.date, item]));

  // 准备图表数据
  const chartData: ChartDataItem[] = buildDateRange(selectedDays).map((date) => {
    const item = trendDataByDate.get(date);
    return {
      date: formatDate(date),
      fullDate: date,
      用户数: item?.userCount ?? 0,
      消息数: item?.messageCount ?? 0,
    };
  });
  const xAxisInterval = Math.max(0, Math.ceil(chartData.length / 10) - 1);

  // 计算统计数据
  const totalUserOccurrences = chartData.reduce((sum, item) => sum + item.用户数, 0);
  const avgUsers = chartData.length > 0 ? Math.round(totalUserOccurrences / chartData.length) : 0;
  const maxUsers = chartData.length > 0 ? Math.max(...chartData.map(item => item.用户数)) : 0;
  const totalMessages = chartData.reduce((sum, item) => sum + item.消息数, 0);
  const avgMessages = chartData.length > 0 ? Math.round(totalMessages / chartData.length) : 0;
  const maxMessages = chartData.length > 0 ? Math.max(...chartData.map(item => item.消息数)) : 0;

  const metricBoards: MetricBoard[] = [
    {
      title: '用户数趋势',
      subtitle: '当日托管独立用户',
      dataKey: '用户数',
      color: THEME_COLORS.primary,
      gradientId: 'colorUsers',
      unit: '人',
      totalUnit: '人次',
      total: totalUserOccurrences,
      average: avgUsers,
      peak: maxUsers,
    },
    {
      title: '消息数趋势',
      subtitle: '用户实际发送消息',
      dataKey: '消息数',
      color: THEME_COLORS.accent,
      gradientId: 'colorMessages',
      unit: '条',
      total: totalMessages,
      average: avgMessages,
      peak: maxMessages,
    },
  ];

  return (
    <section className={styles.section}>
      <div className={`${styles.sectionHeader} ${isExpanded ? styles.expanded : ''}`} onClick={() => setIsExpanded(!isExpanded)}>
        <div className={styles.titleRow}>
          <div className={styles.titleGroup}>
            <h3>
              <div className={styles.headerIcon}>
                <IconTrend />
              </div>
              <span>{selectedRange.label}托管趋势</span>
            </h3>
            {!isExpanded && (
              <div className={styles.statsPreview}>
                <span className={styles.stat}>
                  <span className={styles.label}>平均:</span>
                  <span className={styles.value}>{avgUsers}人/天</span>
                </span>
                <span className={styles.stat}>
                  <span className={styles.label}>消息:</span>
                  <span className={styles.value}>{totalMessages}条</span>
                </span>
              </div>
            )}
            <div
              className={styles.rangeSelector}
              role="group"
              aria-label="趋势时间范围"
              onClick={(event) => event.stopPropagation()}
            >
              {USER_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.days}
                  type="button"
                  className={option.days === selectedDays ? styles.activeRange : undefined}
                  onClick={() => onSelectedDaysChange(option.days)}
                  aria-pressed={option.days === selectedDays}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={`${styles.toggleBtn} ${isExpanded ? styles.expanded : ''}`}
            aria-label={isExpanded ? '收起趋势图' : '展开趋势图'}
            aria-expanded={isExpanded}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        </div>
        {isLoading && <span className={styles.loading}>正在加载数据...</span>}
      </div>

      {isExpanded && (
        <div className={styles.chartWrapper}>
          {/* 统计卡片 */}
          <div className={styles.statsCards}>
            <div className={`${styles.statCard} ${styles.cardPrimary}`}>
              <div className={styles.statIcon} style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
                <IconUsers style={{ color: 'white' }} />
              </div>
              <div className={styles.statInfo}>
                <div className={styles.statLabel}>累计托管人次</div>
                <div className={styles.statValue}>{totalUserOccurrences} <span className={styles.unit}>人次</span></div>
              </div>
            </div>
            <div className={`${styles.statCard} ${styles.cardSecondary}`}>
              <div className={styles.statIcon} style={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' }}>
                <IconBarChart style={{ color: 'white' }} />
              </div>
              <div className={styles.statInfo}>
                <div className={styles.statLabel}>累计消息数</div>
                <div className={styles.statValue}>{totalMessages} <span className={styles.unit}>条</span></div>
              </div>
            </div>
            <div className={`${styles.statCard} ${styles.cardAccent}`}>
              <div className={styles.statIcon} style={{ background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' }}>
                <IconFlame style={{ color: 'white' }} />
              </div>
              <div className={styles.statInfo}>
                <div className={styles.statLabel}>单日用户最高</div>
                <div className={styles.statValue}>{maxUsers} <span className={styles.unit}>人</span></div>
              </div>
            </div>
          </div>

          {/* 数据说明 */}
          <div className={styles.dataNote}>
            <IconInfo width="16" height="16" />
            <span>用户数按当日托管独立用户统计，累计托管人次为各日用户数求和，跨天会重复计数；消息数按用户实际发送条数统计。</span>
          </div>

          {/* 图表区域 */}
          {chartData.length > 0 ? (
            <div className={styles.chartBoards}>
              {metricBoards.map(board => (
                <div className={styles.chartBoard} key={board.dataKey}>
                  <div className={styles.chartBoardHeader}>
                    <div>
                      <h4>{board.title}</h4>
                      <p>{board.subtitle}</p>
                    </div>
                    <div className={styles.boardPeak} style={{ color: board.color }}>
                      峰值 {board.peak}{board.unit}
                    </div>
                  </div>
                  <div className={styles.boardStats}>
                    <span>{selectedRange.totalLabel} <strong>{board.total}</strong>{board.totalUnit || board.unit}</span>
                    <span>日均 <strong>{board.average}</strong>{board.unit}</span>
                  </div>
                  <div className={styles.chartContainer}>
                    <ResponsiveContainer width="100%" height={260}>
                      <AreaChart data={chartData} margin={{ top: 12, right: 24, left: -6, bottom: 0 }}>
                        <defs>
                          <linearGradient id={board.gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={board.color} stopOpacity={0.28} />
                            <stop offset="95%" stopColor={board.color} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                        <XAxis
                          dataKey="date"
                          stroke="#9ca3af"
                          tick={{ fontSize: 12, fill: '#6b7280' }}
                          tickLine={false}
                          axisLine={{ stroke: '#e5e7eb' }}
                          interval={xAxisInterval}
                        />
                        <YAxis
                          stroke="#9ca3af"
                          tick={{ fontSize: 12, fill: '#6b7280' }}
                          tickLine={false}
                          axisLine={{ stroke: '#e5e7eb' }}
                          width={48}
                        />
                        <Tooltip
                          contentStyle={{
                            background: '#ffffff',
                            border: 'none',
                            borderRadius: '12px',
                            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
                            padding: '12px 16px'
                          }}
                          labelStyle={{
                            color: '#1f2937',
                            fontWeight: 600,
                            marginBottom: '8px'
                          }}
                          itemStyle={{
                            color: '#6b7280',
                            fontSize: '13px'
                          }}
                          formatter={(value) => [`${Number(value).toLocaleString()} ${board.unit}`, board.dataKey]}
                          labelFormatter={(label, payload) => {
                            if (payload && payload[0]) {
                              return (payload[0].payload as { fullDate: string }).fullDate;
                            }
                            return String(label);
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey={board.dataKey}
                          stroke={board.color}
                          strokeWidth={3}
                          fill={`url(#${board.gradientId})`}
                          dot={{ r: 3, fill: board.color, strokeWidth: 2, stroke: '#fff' }}
                          activeDot={{ r: 6, fill: board.color, strokeWidth: 2, stroke: '#fff' }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.chartContainer}>
              <div className={styles.emptyState}>
                {isLoading ? (
                  <div className={styles.loadingState}>
                    <div className={styles.spinner}></div>
                    <p>正在加载数据...</p>
                  </div>
                ) : (
                  <div className={styles.emptyContent}>
                    <IconEmpty />
                    <p>暂无趋势数据</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
