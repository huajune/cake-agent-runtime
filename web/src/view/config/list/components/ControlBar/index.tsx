import type { ReactNode } from 'react';
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
  /** 次行控件（页内分区导航），须能一行放下 */
  children?: ReactNode;
}

/**
 * 页头工具卡：首行标题 + 一句说明 + 待保存状态，次行分区导航胶囊。
 * 与流水页 ControlPanel 同一套梦幻底 + 白胶囊语言。
 */
export default function ControlBar({
  title,
  subtitle,
  hints,
  hasChanges,
  pendingChangeCount = 0,
  isPending,
  children,
}: ControlBarProps) {
  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.tagline}>{subtitle}</p> : null}
        {hasChanges && (
          <span className={styles.statusText} role="status">
            {isPending ? '保存中...' : `${pendingChangeCount || 1} 项待保存`}
          </span>
        )}
      </div>
      {children || hints?.length ? (
        <div className={styles.row}>
          {children}
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
      ) : null}
    </div>
  );
}
