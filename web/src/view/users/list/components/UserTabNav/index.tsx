/**
 * 用户页面 Tab 导航组件
 */

import type { TabType } from '../../types';
import styles from './index.module.scss';

interface UserTabNavProps {
  activeTab: TabType;
  todayCount: number;
  pausedCount: number;
  permanentCount: number;
  blacklistCount: number;
  onTabChange: (tab: TabType) => void;
}

export default function UserTabNav({
  activeTab,
  todayCount,
  pausedCount,
  permanentCount,
  blacklistCount,
  onTabChange,
}: UserTabNavProps) {
  return (
    <div className={styles.tabNav}>
      <button
        type="button"
        className={`${styles.tab} ${activeTab === 'today' ? styles.active : ''}`}
        onClick={() => onTabChange('today')}
      >
        <span className={styles.tabLabel}>今日托管会话</span>
        <span className={styles.tabCount}>({todayCount})</span>
      </button>
      <button
        type="button"
        className={`${styles.tab} ${activeTab === 'paused' ? styles.active : ''}`}
        onClick={() => onTabChange('paused')}
      >
        <span className={styles.tabLabel}>临时禁止托管</span>
        <span className={styles.tabCount}>({pausedCount})</span>
      </button>
      <button
        type="button"
        className={`${styles.tab} ${activeTab === 'permanent' ? styles.active : ''}`}
        onClick={() => onTabChange('permanent')}
      >
        <span className={styles.tabLabel}>永久禁止托管</span>
        <span className={styles.tabCount}>({permanentCount})</span>
      </button>
      <button
        type="button"
        className={`${styles.tab} ${activeTab === 'blacklist' ? styles.active : ''}`}
        onClick={() => onTabChange('blacklist')}
      >
        <span className={styles.tabLabel}>候选人黑名单</span>
        <span className={styles.tabCount}>({blacklistCount})</span>
      </button>
    </div>
  );
}
