import type {
  ConversionKpisResponse,
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
import styles from '../../styles/index.module.scss';

interface KpiCardsProps {
  data?: ConversionKpisResponse;
  loading: boolean;
}

export default function KpiCards({ data, loading }: KpiCardsProps) {
  return (
    <>
      {/* KPI 名片固定「同一时段(period)」口径，不随下方各模块的口径开关变化；
          各阶段均按「人」去重，分母为 0 时不计算比率（§2/§6）。 */}
      <p className={styles.caliberNote}>
        口径：同一时段发生量快照（period，固定）· 各阶段按「人」去重 ·
        与下方可切换口径的模块可能不同
      </p>
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
