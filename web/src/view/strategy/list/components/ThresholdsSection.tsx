import { Gauge } from 'lucide-react';
import type { StrategyConfigRecord } from '@/api/types/strategy.types';
import styles from '../styles/index.module.scss';
import s from '../styles/thresholds.module.scss';

interface Props {
  config: StrategyConfigRecord;
}

function formatRange(min?: number, max?: number, unit?: string): string {
  const u = unit ?? '';
  if (min != null && min > 0 && max != null) return `${min}–${max}${u}`;
  if (max != null) return `≤${max}${u}`;
  if (min != null && min > 0) return `≥${min}${u}`;
  return '—';
}

export default function ThresholdsSection({ config }: Props) {
  const thresholds = config.red_lines.thresholds ?? [];

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>
          业务阈值
          <span className={styles.rulesCount}>({thresholds.length})</span>
        </h2>
        <p className={styles.sectionDesc}>
          只放数值型业务硬约束，工具层会自动执行过滤，同时注入系统提示词。不要把纯文字规则放进阈值
        </p>
      </div>

      {thresholds.length === 0 && (
        <div className={styles.emptyListState}>
          <Gauge size={24} className={styles.emptyIcon} />
          <span>暂未配置业务阈值</span>
        </div>
      )}

      <div className={s.thresholdList}>
        {thresholds.map((t, index) => (
          <span key={index} className={s.thresholdTag}>
            <span className={s.tagLabel}>{t.label}</span>
            <span className={s.tagDivider} />
            <span className={s.tagRange}>{formatRange(t.min, t.max, t.unit)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
