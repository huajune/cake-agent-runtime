import { ReactNode, CSSProperties } from 'react';
import styles from './index.module.scss';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  kpiLabel?: string;
  kpiValue?: string | number;
  children: ReactNode;
  fullWidth?: boolean;
  style?: CSSProperties;
}

export default function ChartCard({
  title,
  subtitle,
  kpiLabel,
  kpiValue,
  children,
  fullWidth = false,
  style,
}: ChartCardProps) {
  return (
    <div className={`chart-card ${styles.chartCard} ${fullWidth ? styles.fullWidth : ''}`} style={style}>
      <div className={styles.chartHeader}>
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {kpiLabel && kpiValue !== undefined && (
          <div className={styles.chartKpi}>
            <span>{kpiLabel}</span>
            <strong>{kpiValue}</strong>
          </div>
        )}
      </div>
      <div className={styles.chartContainer}>{children}</div>
    </div>
  );
}

// 导出 ChartsRow 容器组件
interface ChartsRowProps {
  children: ReactNode;
}

export function ChartsRow({ children }: ChartsRowProps) {
  return <section className={`charts-row ${styles.chartsRow}`}>{children}</section>;
}
