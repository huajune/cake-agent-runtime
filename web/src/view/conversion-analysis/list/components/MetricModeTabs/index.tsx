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
        tabIndex={mode === 'period' ? 0 : -1}
        title="同一时间窗内，各阶段分别按候选人去重"
        className={mode === 'period' ? styles.modeTabActive : ''}
        onClick={() => onChange('period')}
      >
        同期发生量
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'cohort'}
        tabIndex={mode === 'cohort' ? 0 : -1}
        title="从同一批新增好友出发，追踪其后续转化"
        className={mode === 'cohort' ? styles.modeTabActive : ''}
        onClick={() => onChange('cohort')}
      >
        成熟同批追踪
      </button>
    </div>
  );
}
