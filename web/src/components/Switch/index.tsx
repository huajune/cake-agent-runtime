import type { InputHTMLAttributes } from 'react';
import styles from './index.module.scss';

interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'onChange' | 'checked'> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** md 38×22（默认）/ sm 32×18（表格行内） */
  size?: 'sm' | 'md';
  /** 处理中：禁用交互，轨道轻微呼吸 */
  pending?: boolean;
}

/**
 * 自绘开关：药丸轨道 + 带双层投影的白色旋钮。
 * 开启态主题渐变紫，关闭态淡丁香底 + 细边；按下时旋钮拉长，键盘聚焦有外圈。
 */
export default function Switch({
  checked,
  onChange,
  size = 'md',
  pending = false,
  disabled = false,
  className,
  ...rest
}: SwitchProps) {
  const classes = [
    styles.switch,
    size === 'sm' ? styles.sm : '',
    pending ? styles.pending : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      <input
        {...rest}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className={styles.input}
        checked={checked}
        disabled={disabled || pending}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.knob} />
      </span>
    </span>
  );
}
