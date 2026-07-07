import { getStatusMeta } from '../../constants';
import styles from './index.module.scss';

interface StatusBadgeProps {
  status: string;
  title?: string;
}

/**
 * 状态徽章：info/success/warning/danger 走全局 status-badge 色调，
 * neutral/muted（Shadow、预检跳过等）使用本模块的灰色系变体。
 */
export default function StatusBadge({ status, title }: StatusBadgeProps) {
  const meta = getStatusMeta(status);
  const toneClass =
    meta.tone === 'neutral' ? styles.neutral : meta.tone === 'muted' ? styles.muted : meta.tone;

  return (
    <span className={`status-badge ${toneClass}`} title={title || meta.label}>
      {meta.label}
    </span>
  );
}
