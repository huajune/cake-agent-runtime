import styles from './index.module.scss';

interface Tab<T extends string> {
  key: T;
  label: string;
  count?: number;
}

interface TabSwitchProps<T extends string> {
  tabs: Tab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
}

export function TabSwitch<T extends string>({ tabs, activeTab, onTabChange }: TabSwitchProps<T>) {
  return (
    <div className={styles.tabSwitch}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={`${styles.tab} ${activeTab === tab.key ? styles.active : ''}`}
          onClick={() => onTabChange(tab.key)}
        >
          <span className={styles.tabLabel}>{tab.label}</span>
          {tab.count !== undefined && tab.count > 0 && (
            <span className={styles.badge}>{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
