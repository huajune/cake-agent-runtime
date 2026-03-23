import { ReactNode, CSSProperties } from 'react';
import styles from './index.module.scss';

interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle?: ReactNode;
  delta?: number;
  deltaInverse?: boolean; // 当 delta 为负数时显示为正面（如响应时间降低是好事）
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
  variant = 'default',
  timeRangeBadge,
  className,
  style,
}: MetricCardProps) {
  const isPositive = deltaInverse ? (delta ?? 0) <= 0 : (delta ?? 0) >= 0;
  const deltaClass = isPositive ? 'positive' : 'negative';
  const deltaSign = (delta ?? 0) >= 0 ? '+' : '';

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
        <div className={`metric-delta ${deltaClass} ${styles.metricDelta} ${styles[deltaClass]}`}>
          {deltaSign}
          {delta.toFixed(1)}%
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
