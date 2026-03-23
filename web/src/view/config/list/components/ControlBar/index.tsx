import styles from './index.module.scss';

interface ControlBarProps {
  title: string;
  icon?: string;
  hasChanges: boolean;
  isPending: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export default function ControlBar({
  title,
  icon = '⚙️',
  hasChanges,
  isPending,
  onSave,
  onCancel,
}: ControlBarProps) {
  return (
    <div className={styles.controlBar}>
      <h3 className={styles.title}>
        <span className={styles.icon}>{icon}</span>
        {title}
      </h3>

      {hasChanges && (
        <div className={styles.actions}>
          <button className={styles.btnGhost} onClick={onCancel}>
            取消
          </button>
          <button className={styles.btnPrimary} onClick={onSave} disabled={isPending}>
            {isPending ? '保存中...' : '保存更改'}
          </button>
        </div>
      )}
    </div>
  );
}
