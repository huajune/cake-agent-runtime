/**
 * 用户页面 Tab 导航组件
 */

import type { TabType } from '../../types';
import styles from './index.module.scss';

interface UserTabNavProps {
  activeTab: TabType;
  todayCount: number;
  pausedCount: number;
  onTabChange: (tab: TabType) => void;
}

export default function UserTabNav({
  activeTab,
  todayCount,
  pausedCount,
  onTabChange,
}: UserTabNavProps) {
  return (
    <div className={styles.tabNav}>
      <button
        className={`${styles.tab} ${activeTab === 'today' ? styles.active : ''}`}
        onClick={() => onTabChange('today')}
      >
        <span className={styles.tabLabel}>今日托管会话</span>
        <span className={styles.tabCount}>({todayCount})</span>
      </button>
      <button
        className={`${styles.tab} ${activeTab === 'paused' ? styles.active : ''}`}
        onClick={() => onTabChange('paused')}
      >
        <span className={styles.tabLabel}>已禁止托管会话</span>
        <span className={styles.tabCount}>({pausedCount})</span>
      </button>
    </div>
  );
}
