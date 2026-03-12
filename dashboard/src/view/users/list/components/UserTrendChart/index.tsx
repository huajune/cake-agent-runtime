import { useState } from 'react';
import { useUserTrend } from '@/hooks/user/useUsers';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Area, AreaChart } from 'recharts';
import { IconUsers, IconBarChart, IconFlame, IconTrend, IconEmpty, IconInfo } from '../Icons';
import { THEME_COLORS } from '@/constants';
import styles from './index.module.scss';

export default function UserTrendChart() {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data: trendData = [], isLoading } = useUserTrend();

  // 格式化日期显示（MM-DD）
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${month}/${day}`;
  };

  // 准备图表数据
  const chartData = trendData.map(item => ({
    date: formatDate(item.date),
    fullDate: item.date,
    用户数: item.uniqueUsers,
    消息数: item.messageCount,
  }));

  // 计算统计数据
  const totalUsers = chartData.reduce((sum, item) => sum + item.用户数, 0);
  const avgUsers = chartData.length > 0 ? Math.round(totalUsers / chartData.length) : 0;
  const maxUsers = chartData.length > 0 ? Math.max(...chartData.map(item => item.用户数)) : 0;
  const totalMessages = chartData.reduce((sum, item) => sum + item.消息数, 0);

  return (
    <section className={styles.section}>
      <div className={`${styles.sectionHeader} ${isExpanded ? styles.expanded : ''}`} onClick={() => setIsExpanded(!isExpanded)}>
        <div className={styles.titleRow}>
          <div className={styles.titleGroup}>
            <h3>
              <div className={styles.headerIcon}>
                <IconTrend />
              </div>
              <span>近30天托管用户趋势</span>
            </h3>
            {!isExpanded && (
              <div className={styles.statsPreview}>
                <span className={styles.stat}>
                  <span className={styles.label}>平均:</span>
                  <span className={styles.value}>{avgUsers}人/天</span>
                </span>
                <span className={styles.stat}>
                  <span className={styles.label}>峰值:</span>
                  <span className={styles.value}>{maxUsers}人</span>
                </span>
              </div>
            )}
          </div>
          <button className={`${styles.toggleBtn} ${isExpanded ? styles.expanded : ''}`}>
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
                <div className={styles.statLabel}>累计托管用户</div>
                <div className={styles.statValue}>{totalUsers} <span className={styles.unit}>人</span></div>
              </div>
            </div>
            <div className={`${styles.statCard} ${styles.cardSecondary}`}>
              <div className={styles.statIcon} style={{ background: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)' }}>
                <IconBarChart style={{ color: 'white' }} />
              </div>
              <div className={styles.statInfo}>
                <div className={styles.statLabel}>日均托管用户</div>
                <div className={styles.statValue}>{avgUsers} <span className={styles.unit}>人</span></div>
              </div>
            </div>
            <div className={`${styles.statCard} ${styles.cardAccent}`}>
              <div className={styles.statIcon} style={{ background: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)' }}>
                <IconFlame style={{ color: 'white' }} />
              </div>
              <div className={styles.statInfo}>
                <div className={styles.statLabel}>单日最高</div>
                <div className={styles.statValue}>{maxUsers} <span className={styles.unit}>人</span></div>
              </div>
            </div>
          </div>

          {/* 数据说明 */}
          <div className={styles.dataNote}>
            <IconInfo width="16" height="16" />
            <span>消息数 = 用户实际发送的消息条数（30天累计: {totalMessages} 条）</span>
          </div>

          {/* 图表区域 */}
          <div className={styles.chartContainer}>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorUsers" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={THEME_COLORS.primary} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={THEME_COLORS.primary} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorMessages" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={THEME_COLORS.accent} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={THEME_COLORS.accent} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                  <XAxis
                    dataKey="date"
                    stroke="#9ca3af"
                    tick={{ fontSize: 12, fill: '#6b7280' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e5e7eb' }}
                  />
                  <YAxis
                    stroke="#9ca3af"
                    tick={{ fontSize: 12, fill: '#6b7280' }}
                    tickLine={false}
                    axisLine={{ stroke: '#e5e7eb' }}
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
                    labelFormatter={(label: string, payload: any) => {
                      if (payload && payload[0]) {
                        return `📅 ${payload[0].payload.fullDate}`;
                      }
                      return label;
                    }}
                  />
                  <Legend
                    wrapperStyle={{
                      fontSize: '13px',
                      paddingTop: '20px'
                    }}
                    iconType="circle"
                  />
                  <Area
                    type="monotone"
                    dataKey="用户数"
                    stroke={THEME_COLORS.primary}
                    strokeWidth={3}
                    fill="url(#colorUsers)"
                    dot={{ r: 3, fill: THEME_COLORS.primary, strokeWidth: 2, stroke: '#fff' }}
                    activeDot={{ r: 6, fill: THEME_COLORS.primary, strokeWidth: 2, stroke: '#fff' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="消息数"
                    stroke={THEME_COLORS.accent}
                    strokeWidth={3}
                    fill="url(#colorMessages)"
                    dot={{ r: 3, fill: THEME_COLORS.accent, strokeWidth: 2, stroke: '#fff' }}
                    activeDot={{ r: 6, fill: THEME_COLORS.accent, strokeWidth: 2, stroke: '#fff' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
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
            )}
          </div>
        </div>
      )}
    </section>
  );
}
