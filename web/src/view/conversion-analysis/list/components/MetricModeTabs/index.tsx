import type { ConversionMetricMode } from '@/api/types/conversion-analytics.types';
import styles from '../../styles/index.module.scss';

interface MetricModeTabsProps {
  mode: ConversionMetricMode;
  onChange: (mode: ConversionMetricMode) => void;
  label?: string;
}

export default function MetricModeTabs({
  mode,
  onChange,
  label = '数据口径',
}: MetricModeTabsProps) {
  return (
    <div className={styles.modeTabs} role="tablist" aria-label={label}>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'period'}
        className={mode === 'period' ? styles.modeTabActive : ''}
        onClick={() => onChange('period')}
      >
        同一时段
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'cohort'}
        className={mode === 'cohort' ? styles.modeTabActive : ''}
        onClick={() => onChange('cohort')}
      >
        同批追踪
      </button>
    </div>
  );
}
