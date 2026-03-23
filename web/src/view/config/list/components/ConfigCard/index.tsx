import styles from './index.module.scss';

// 配置项元数据类型
export interface ConfigMeta {
  key: string;
  label: string;
  description: string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  category: 'merge' | 'typing';
  type?: 'number' | 'boolean';
}

// 格式化配置显示值
export function formatConfigValue(key: string, value: number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? '已启用' : '已禁用';
  }
  if (key.endsWith('Ms')) {
    if (value >= 1000) {
      return `${(value / 1000).toFixed(1)} 秒`;
    }
    return `${value} ms`;
  }
  return `${value}`;
}

interface NumberCardProps {
  meta: ConfigMeta;
  currentValue: number;
  defaultValue: number;
  onChange: (key: string, value: number) => void;
}

export function NumberCard({ meta, currentValue, defaultValue, onChange }: NumberCardProps) {
  const isModified = currentValue !== defaultValue;

  return (
    <div className={`${styles.card} ${isModified ? styles.modified : ''}`}>
      <div className={styles.header}>
        <span className={styles.label}>{meta.label}</span>
        <span className={styles.value}>{formatConfigValue(meta.key, currentValue)}</span>
      </div>
      <p className={styles.description}>{meta.description}</p>
      <div className={styles.sliderRow}>
        <input
          type="range"
          className={styles.slider}
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={currentValue}
          onChange={(e) => onChange(meta.key, Number(e.target.value))}
        />
        <input
          type="number"
          className={styles.numberInput}
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={currentValue}
          onChange={(e) => onChange(meta.key, Number(e.target.value))}
        />
      </div>
      <div className={styles.footer}>
        <span>
          {meta.min} - {meta.max} {meta.unit}
        </span>
        <span>默认: {formatConfigValue(meta.key, defaultValue)}</span>
      </div>
    </div>
  );
}

interface BooleanCardProps {
  meta: ConfigMeta;
  currentValue: boolean;
  defaultValue: boolean;
  onChange: (key: string, value: boolean) => void;
}

export function BooleanCard({ meta, currentValue, defaultValue, onChange }: BooleanCardProps) {
  const isModified = currentValue !== defaultValue;

  return (
    <div className={`${styles.card} ${isModified ? styles.modified : ''}`}>
      <div className={styles.header}>
        <span className={styles.label}>{meta.label}</span>
        <div className={styles.toggleSwitch}>
          <input
            type="checkbox"
            checked={currentValue}
            onChange={(e) => onChange(meta.key, e.target.checked)}
          />
          <span className={styles.track} />
        </div>
      </div>
      <p className={styles.description}>{meta.description}</p>
    </div>
  );
}
