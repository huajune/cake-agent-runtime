import styles from './index.module.scss';

interface ControlHint {
  label: string;
}

interface ControlBarProps {
  title: string;
  subtitle?: string;
  hints?: ControlHint[];
  hasChanges: boolean;
  pendingChangeCount?: number;
  isPending: boolean;
}

export default function ControlBar({
  title,
  subtitle,
  hints,
  hasChanges,
  pendingChangeCount = 0,
  isPending,
}: ControlBarProps) {
  return (
    <div className={styles.controlBar}>
      <div className={styles.titleBlock}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {hasChanges && (
            <span className={styles.statusText} role="status">
              {isPending ? '保存中...' : `${pendingChangeCount || 1} 项待保存`}
            </span>
          )}
        </div>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        {hints?.length ? (
          <div className={styles.hintList}>
            {hints.map((hint) => (
              <span key={hint.label} className={styles.hintItem}>
                {hint.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
