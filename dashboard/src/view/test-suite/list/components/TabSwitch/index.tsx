import { TestType } from '../../types';
import styles from './index.module.scss';

interface TabSwitchProps {
  activeTab: TestType;
  onTabChange: (tab: TestType) => void;
  scenarioCount?: number;
  conversationCount?: number;
}

/**
 * 测试类型切换 Tab
 * 用于切换「场景测试」和「对话验证」两种模式
 */
export function TabSwitch({
  activeTab,
  onTabChange,
  scenarioCount = 0,
  conversationCount = 0,
}: TabSwitchProps) {
  return (
    <div className={styles.tabSwitch}>
      <button
        className={`${styles.tab} ${activeTab === 'scenario' ? styles.active : ''}`}
        onClick={() => onTabChange('scenario')}
      >
        <span className={styles.tabLabel}>场景测试</span>
        {scenarioCount > 0 && <span className={styles.badge}>{scenarioCount}</span>}
      </button>
      <button
        className={`${styles.tab} ${activeTab === 'conversation' ? styles.active : ''}`}
        onClick={() => onTabChange('conversation')}
      >
        <span className={styles.tabLabel}>对话验证</span>
        {conversationCount > 0 && <span className={styles.badge}>{conversationCount}</span>}
      </button>
    </div>
  );
}
