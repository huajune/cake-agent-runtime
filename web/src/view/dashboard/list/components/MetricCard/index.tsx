import { ReactNode, CSSProperties } from 'react';
import styles from './index.module.scss';

interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle?: ReactNode;
  delta?: number;
  deltaInverse?: boolean; // 当 delta 为负数时显示为正面（如响应时间降低是好事）
  deltaLabel?: string;
  deltaUnit?: 'percent' | 'points';
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
  timeRangeBadge?: string;
  className?: string;
  style?: CSSProperties;
}

export default function MetricCard({
  label,
  value,
  subtitle,
  delta,
  deltaInverse = false,
  deltaLabel,
  deltaUnit = 'percent',
  variant = 'default',
  timeRangeBadge,
  className,
  style,
}: MetricCardProps) {
  const deltaValue = delta ?? 0;
  const isNeutral = Math.abs(deltaValue) < 0.05;
  const isPositive = isNeutral || (deltaInverse ? deltaValue <= 0 : deltaValue >= 0);
  const deltaClass = isNeutral ? 'neutral' : isPositive ? 'positive' : 'negative';
  const deltaSign = deltaValue > 0 ? '+' : deltaValue < 0 ? '-' : '';
  const deltaText = isNeutral
    ? '持平'
    : `${deltaSign}${Math.abs(deltaValue).toFixed(1)}${deltaUnit === 'points' ? ' 个百分点' : '%'}`;

  // 同时包含全局类名（用于圣诞装饰等 JS 选择器）和模块化类名（用于样式隔离）
  const variantGlobal = variant !== 'default' ? variant : '';

  return (
    <article
      className={`metric-card ${variantGlobal} ${styles.metricCard} ${variant !== 'default' ? styles[variant] : ''} ${className || ''}`}
      style={style}
    >
      <div className={`metric-label ${styles.metricLabel}`}>
        {label}
        {timeRangeBadge && (
          <span className="time-range-badge">
            {timeRangeBadge}
          </span>
        )}
      </div>
      <div className={`metric-value ${styles.metricValue}`}>{value}</div>
      {subtitle && <div className={`metric-subtitle ${styles.metricSubtitle}`}>{subtitle}</div>}
      {delta !== undefined && (
        <div
          className={`metric-delta ${deltaClass} ${styles.metricDelta} ${styles[deltaClass]}`}
          title={`${deltaLabel || '较上期'}${isNeutral ? '持平' : ` ${deltaText}`}`}
        >
          {deltaLabel && <span className={styles.deltaLabel}>{deltaLabel}</span>}
          <span>{deltaText}</span>
        </div>
      )}
    </article>
  );
}

// 导出 MetricGrid 容器组件
interface MetricGridProps {
  children: ReactNode;
  columns?: number;
  style?: CSSProperties;
}

export function MetricGrid({ children, columns, style }: MetricGridProps) {
  const gridStyle: CSSProperties = {
    ...style,
    ...(columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : {}),
  };

  return (
    <section className={`metric-grid ${styles.metricGrid}`} style={gridStyle}>
      {children}
    </section>
  );
}
