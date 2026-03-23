import { ReactNode, CSSProperties } from 'react';
import styles from './index.module.scss';

type KpiVariant = 'default' | 'primary' | 'warning' | 'danger' | 'info';
type TrendDirection = 'up' | 'down' | 'flat';

interface KpiCardProps {
  icon: string;
  variant?: KpiVariant;
  label: string;
  value: string | number;
  valueVariant?: KpiVariant;
  trend?: {
    direction: TrendDirection;
    value: string;
    label: string;
  };
  title?: string;
}

export default function KpiCard({
  icon,
  variant = 'default',
  label,
  value,
  valueVariant,
  trend,
  title,
}: KpiCardProps) {
  const variantBgClass = variant === 'primary' ? styles.primaryBg
    : variant === 'warning' ? styles.warningBg
    : variant === 'danger' ? styles.dangerBg
    : variant === 'info' ? styles.infoBg
    : '';

  const valueClass = valueVariant === 'primary' ? styles.primary
    : valueVariant === 'warning' ? styles.warning
    : valueVariant === 'danger' ? styles.danger
    : valueVariant === 'info' ? styles.info
    : '';

  const trendClass = trend?.direction === 'up' ? styles.up
    : trend?.direction === 'down' ? styles.down
    : styles.flat;

  return (
    <div className={styles.kpiCard} title={title}>
      <div className={`${styles.kpiIcon} ${variantBgClass}`}>{icon}</div>
      <div className={styles.kpiContent}>
        <div className={styles.kpiLabel}>{label}</div>
        <div className={`${styles.kpiValue} ${valueClass}`}>
          {value}
        </div>
        {trend && (
          <div className={`${styles.kpiTrend} ${trendClass}`}>
            {trend.direction === 'up' ? '↗' : trend.direction === 'down' ? '↘' : '→'} {trend.value}{' '}
            <span className={styles.trendLabel}>{trend.label}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// 导出 KpiGrid 容器组件
interface KpiGridProps {
  children: ReactNode;
  style?: CSSProperties;
}

export function KpiGrid({ children, style }: KpiGridProps) {
  return (
    <div className={styles.kpiGrid} style={style}>
      {children}
    </div>
  );
}
