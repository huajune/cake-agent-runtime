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

interface SelectCardProps {
  label: string;
  description: string;
  fieldKey: string;
  currentValue: string;
  defaultValue: string;
  options: string[];
  placeholder: string;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}

export function SelectCard({
  label,
  description,
  fieldKey,
  currentValue,
  defaultValue,
  options,
  placeholder,
  onChange,
  disabled = false,
}: SelectCardProps) {
  const isModified = currentValue !== defaultValue;
  const displayValue = currentValue || placeholder;

  return (
    <div className={`${styles.card} ${isModified ? styles.modified : ''}`}>
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        <span className={styles.valueText}>{displayValue}</span>
      </div>
      <p className={styles.description}>{description}</p>
      <div className={styles.selectRow}>
        <select
          className={styles.selectInput}
          value={currentValue}
          onChange={(e) => onChange(fieldKey, e.target.value)}
          disabled={disabled}
        >
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.footer}>
        <span>留空时走默认角色路由</span>
        <span>默认: {defaultValue || placeholder}</span>
      </div>
    </div>
  );
}
