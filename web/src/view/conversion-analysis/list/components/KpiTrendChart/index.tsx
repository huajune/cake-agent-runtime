import type {
  ConversionKpisResponse,
  ConversionMetricMode,
  ConversionTrendPoint,
  ConversionTrendResponse,
} from '@/api/types/conversion-analytics.types';
import type { CSSProperties } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import heroArt from '@/assets/images/conversion-growth-hero.png';
import { useCountUp } from '@/hooks/useCountUp';
import { isWeekendDate } from '@/utils/date-range';
import MetricModeTabs from '../MetricModeTabs';
import { KPI_DEFS } from '../../types';
import styles from '../../styles/index.module.scss';

interface KpiTrendChartProps {
  data?: ConversionTrendResponse;
  loading: boolean;
  mode: ConversionMetricMode;
  maturityDays: number;
  onModeChange: (mode: ConversionMetricMode) => void;
}

type RateKey = keyof Pick<
  ConversionTrendPoint,
  'breakIceRate' | 'bookingRate' | 'groupInviteRate' | 'passRate' | 'overallRate'
>;

type CountKey = keyof Pick<
  ConversionTrendPoint,
  'friendAdded' | 'breakIce' | 'booking' | 'interviewPass' | 'groupInvite'
>;

// 与 KPI 名片同源（key/label/formula 复用 KPI_DEFS），额外补充折线颜色与分子/分母字段。
// 颜色取各 tone 的主色，和名片渐变首色一致（teal/sky/rose/amber/purple）。
const TREND_EXTRA: Record<
  keyof ConversionKpisResponse,
  { color: string; numeratorKey: CountKey; denominatorKey: CountKey }
> = {
  breakIceRate: { color: '#10b981', numeratorKey: 'breakIce', denominatorKey: 'friendAdded' },
  bookingRate: { color: '#0ea5e9', numeratorKey: 'booking', denominatorKey: 'breakIce' },
  groupInviteRate: { color: '#ec4899', numeratorKey: 'groupInvite', denominatorKey: 'breakIce' },
  passRate: { color: '#f59e0b', numeratorKey: 'interviewPass', denominatorKey: 'booking' },
  overallRate: { color: '#8b5cf6', numeratorKey: 'interviewPass', denominatorKey: 'friendAdded' },
};

const TREND_METRICS = KPI_DEFS.map((def) => ({
  key: def.key as RateKey,
  label: def.label,
  formula: def.formula,
  ...TREND_EXTRA[def.key],
}));

// 同批追踪（cohort）口径的公式文案：强调「同一批新增好友」逐级追踪，与上方 period 名片区分。
// 比值结构与 period 相同，差异在于计数方式（同时段各自独立 vs 同一批人逐级），故文案加「同批」前缀。
const COHORT_FORMULAS: Record<RateKey, string> = {
  breakIceRate: '= 同批破冰 / 同批新增好友',
  groupInviteRate: '= 同批加群 / 同批破冰',
  bookingRate: '= 同批报名 / 同批破冰',
  passRate: '= 同批面试通过 / 同批报名',
  overallRate: '= 同批面试通过 / 同批新增好友',
};

interface ChartDatum extends ConversionTrendPoint {
  label: string;
}

export default function KpiTrendChart({
  data,
  loading,
  mode,
  maturityDays,
  onModeChange,
}: KpiTrendChartProps) {
  // 剔除周末（与「托管趋势」口径一致）：餐饮招聘周末基本无新增，留着只会拉出无意义断点。
  const chartData: ChartDatum[] = (data?.points ?? [])
    .filter((point) => !isWeekendDate(parseLocalDate(point.date)))
    .map((point) => ({ ...point, label: formatMonthDay(point.date) }));
  const hasData = chartData.length > 0;
  const xAxisInterval = Math.max(0, Math.ceil(chartData.length / 8) - 1);

  // 卡片右上的大数 = 接口返回的整段范围汇总，和上方 KPI 使用同一个 mode 与去重口径。
  const totals = data?.summary ?? sumPointCounts(data?.points ?? []);

  return (
    <section className={`${styles.panel} ${styles.trendPanel}`}>
      <img className={styles.trendPanelArt} src={heroArt} alt="" aria-hidden="true" />
      <div className={styles.panelHeader}>
        <div>
          <span className={styles.sectionKicker}>趋势洞察</span>
          <h2>关键指标趋势</h2>
          <span>{trendDescription(mode, maturityDays)}</span>
        </div>
        <MetricModeTabs mode={mode} onChange={onModeChange} label="关键指标趋势口径" />
      </div>

      {loading && !hasData ? (
        <div className={styles.trendEmpty}>加载中</div>
      ) : hasData ? (
        <div className={styles.trendGrid}>
          {TREND_METRICS.map((metric) => {
            const numerator = totals[metric.numeratorKey];
            const denominator = totals[metric.denominatorKey];
            const rate = denominator > 0 ? roundRate(numerator / denominator) : null;
            return (
              <article
                className={styles.trendCard}
                key={metric.key}
                style={{ '--trend-tone': metric.color } as CSSProperties}
              >
                <header className={styles.trendCardHeader}>
                  <div>
                    <strong>{metric.label}</strong>
                    <span>{mode === 'cohort' ? COHORT_FORMULAS[metric.key] : metric.formula}</span>
                  </div>
                  <div className={styles.trendCardStat}>
                    <TrendStatValue rate={rate} color={metric.color} />
                    <small>
                      {numerator} / {denominator}
                    </small>
                  </div>
                </header>
                <div className={styles.trendChartBox}>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={chartData} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef0f5" vertical={false} />
                      <XAxis
                        dataKey="label"
                        stroke="#9ca3af"
                        tick={{ fontSize: 11, fill: '#6b7280' }}
                        tickLine={false}
                        axisLine={{ stroke: '#e5e7eb' }}
                        interval={xAxisInterval}
                        minTickGap={8}
                      />
                      <YAxis
                        stroke="#9ca3af"
                        tick={{ fontSize: 11, fill: '#6b7280' }}
                        tickLine={false}
                        axisLine={{ stroke: '#e5e7eb' }}
                        width={44}
                        domain={[0, 'auto']}
                        tickFormatter={(value) => formatPercent(Number(value))}
                      />
                      <Tooltip
                        content={
                          <TrendTooltip
                            color={metric.color}
                            label={metric.label}
                            rateKey={metric.key}
                            numeratorKey={metric.numeratorKey}
                            denominatorKey={metric.denominatorKey}
                          />
                        }
                        cursor={{
                          stroke: metric.color,
                          strokeDasharray: '4 4',
                          strokeOpacity: 0.5,
                        }}
                      />
                      <Line
                        type="monotone"
                        dataKey={metric.key}
                        stroke={metric.color}
                        strokeWidth={2.4}
                        dot={chartData.length <= 31 ? { r: 2, fill: metric.color } : false}
                        connectNulls={false}
                        activeDot={{ r: 5, fill: metric.color, strokeWidth: 2, stroke: '#fff' }}
                        isAnimationActive
                        animationDuration={1200}
                        animationEasing="ease-out"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.trendEmpty}>暂无趋势数据</div>
      )}
    </section>
  );
}

function TrendTooltip({
  active,
  payload,
  color,
  label,
  rateKey,
  numeratorKey,
  denominatorKey,
}: {
  active?: boolean;
  payload?: Array<{ payload?: ChartDatum }>;
  color: string;
  label: string;
  rateKey: RateKey;
  numeratorKey: CountKey;
  denominatorKey: CountKey;
}) {
  const datum = payload?.[0]?.payload;
  if (!active || !datum) {
    return null;
  }

  const rate = datum[rateKey];
  return (
    <div className={styles.trendTooltip} style={{ '--trend-tone': color } as CSSProperties}>
      <strong>{datum.date}</strong>
      <span>
        {label} <em>{rate == null ? '无数据' : formatPercent(rate)}</em>
      </span>
      <small>
        {datum[numeratorKey]} / {datum[denominatorKey]} 人
      </small>
    </div>
  );
}

function sumPointCounts(points: ConversionTrendPoint[]): Record<CountKey, number> {
  return points.reduce<Record<CountKey, number>>(
    (acc, point) => {
      acc.friendAdded += point.friendAdded;
      acc.breakIce += point.breakIce;
      acc.booking += point.booking;
      acc.interviewPass += point.interviewPass;
      acc.groupInvite += point.groupInvite;
      return acc;
    },
    { friendAdded: 0, breakIce: 0, booking: 0, interviewPass: 0, groupInvite: 0 },
  );
}

function trendDescription(mode: ConversionMetricMode, maturityDays: number) {
  return mode === 'period'
    ? '按天查看同一时间窗内各阶段发生量（全局按候选人去重，已剔除周末）'
    : `按新增好友入列日追踪至少成熟 ${maturityDays} 天的同批后续转化（按人去重，已剔除周末）`;
}

// 卡片右上的大数：从 0 滚动到目标值，与 KPI 名片的计数动画一致。
function TrendStatValue({ rate, color }: { rate: number | null; color: string }) {
  const animated = useCountUp(rate ?? 0);
  return <em style={{ color }}>{rate == null ? '—' : formatPercent(animated)}</em>;
}

function formatPercent(value?: number | null) {
  if (value == null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

function roundRate(value: number) {
  return Number(value.toFixed(4));
}

function formatMonthDay(date: string) {
  const [, month, day] = date.split('-');
  if (!month || !day) return date;
  return `${Number(month)}/${Number(day)}`;
}

function parseLocalDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day);
}
