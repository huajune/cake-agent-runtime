import type {
  ConversionKpisResponse,
  ConversionMetricMode,
  ConversionRateMetric,
} from '@/api/types/conversion-analytics.types';
import {
  BadgeCheck,
  CalendarCheck2,
  MessageCircle,
  MousePointerClick,
  type LucideIcon,
  Rocket,
} from 'lucide-react';
import { useCountUp } from '@/hooks/useCountUp';
import { KPI_DEFS } from '../../types';
import MetricModeTabs from '../MetricModeTabs';
import styles from '../../styles/index.module.scss';

interface KpiCardsProps {
  data?: ConversionKpisResponse;
  loading: boolean;
  mode: ConversionMetricMode;
  maturityDays: number;
  onModeChange: (mode: ConversionMetricMode) => void;
}

export default function KpiCards({
  data,
  loading,
  mode,
  maturityDays,
  onModeChange,
}: KpiCardsProps) {
  return (
    <>
      <div className={styles.caliberToolbar}>
        <p className={styles.caliberNote}>
          {mode === 'cohort'
            ? `口径：仅统计至少成熟 ${maturityDays} 天的新增好友批次 · 同一批人逐级追踪 · 各阶段按人去重`
            : '口径：同一时间窗内各阶段分别发生 · 全局按候选人去重 · 非严格漏斗'}
        </p>
        <MetricModeTabs mode={mode} onChange={onModeChange} label="核心指标口径" />
      </div>
      <section className={styles.kpiBand}>
        {KPI_DEFS.map((item) => {
          const Icon = KPI_ICONS[item.key];
          return (
            <KpiCell
              key={item.key}
              label={item.label}
              formula={item.formula}
              tone={item.tone}
              icon={Icon}
              metric={data?.[item.key]}
              loading={loading}
            />
          );
        })}
      </section>
    </>
  );
}

const KPI_ICONS: Record<keyof ConversionKpisResponse, LucideIcon> = {
  breakIceRate: MessageCircle,
  bookingRate: CalendarCheck2,
  groupInviteRate: MousePointerClick,
  passRate: BadgeCheck,
  overallRate: Rocket,
};

function KpiCell({
  label,
  formula,
  tone,
  icon: Icon,
  metric,
  loading,
}: {
  label: string;
  formula: string;
  tone: string;
  icon: LucideIcon;
  metric?: ConversionRateMetric;
  loading: boolean;
}) {
  const change = metric?.change ?? 0;
  const changeClass =
    Math.abs(change) < 0.05 ? styles.neutral : change > 0 ? styles.up : styles.down;
  const animatedCurrent = useCountUp(metric?.current ?? 0);

  return (
    <article className={`${styles.kpiCell} ${styles[tone]}`}>
      <div className={styles.kpiTop}>
        <span className={styles.kpiIcon}>
          <Icon size={20} />
        </span>
        <span className={styles.kpiLabel}>{label}</span>
      </div>
      <p className={styles.kpiMeaning}>{formula}</p>
      <strong className={styles.kpiValue}>{loading ? '-' : formatPercent(animatedCurrent)}</strong>
      <div className={styles.kpiMeta}>
        <em className={changeClass}>{loading ? '-' : formatPp(metric?.change)}</em>
        <span>{loading ? '-' : `${metric?.numerator ?? 0}/${metric?.denominator ?? 0}`}</span>
      </div>
      <span className={styles.kpiBeam} />
    </article>
  );
}

function formatPercent(value?: number) {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}

function formatPp(value?: number) {
  const pp = value ?? 0;
  if (Math.abs(pp) < 0.05) return '持平';
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}
