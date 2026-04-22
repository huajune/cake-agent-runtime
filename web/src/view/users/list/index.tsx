import { useState } from 'react';
import { useTodayUsers, useToggleUserHosting, usePausedUsers } from '@/hooks/user/useUsers';

// 类型导入
import type { TabType } from './types';

// 工具函数导入
import { transformPausedUsers } from './utils/transformers';

// 组件导入
import UserTable from './components/UserTable';
import UserTrendChart from './components/UserTrendChart';
import UserTabNav from './components/UserTabNav';

// 样式导入
import styles from './styles/index.module.scss';

export default function Users() {
  const [activeTab, setActiveTab] = useState<TabType>('today');
  const { data: todayUsers = [], isLoading: isTodayLoading } = useTodayUsers();
  const { data: pausedUsers = [], isLoading: isPausedLoading } = usePausedUsers();
  const toggleHosting = useToggleUserHosting();

  const handleToggleHosting = (chatId: string, enabled: boolean) => {
    toggleHosting.mutate({ chatId, enabled });
  };

  const pausedUsersData = transformPausedUsers(pausedUsers);

  const displayUsers = activeTab === 'today' ? todayUsers : pausedUsersData;
  const isLoading = activeTab === 'today' ? isTodayLoading : isPausedLoading;

  return (
    <div className={styles.page}>
      {/* 近1月托管用户趋势图 */}
      <UserTrendChart />

      {/* Tab 切换 + 用户列表 */}
      <section className={styles.section}>
        <UserTabNav
          activeTab={activeTab}
          todayCount={todayUsers.length}
          pausedCount={pausedUsers.length}
          onTabChange={setActiveTab}
        />

        {activeTab === 'paused' && (
          <div className={styles.tabHint}>
            <span className={styles.tabHintIcon}>ℹ️</span>
            <span>禁止托管后，系统将在 3 天后自动恢复托管；如需提前恢复，请手动切换上方"托管状态"开关。</span>
          </div>
        )}

        {/* 用户表格 */}
        <UserTable
          users={displayUsers}
          isLoading={isLoading}
          onToggleHosting={handleToggleHosting}
          isPausedTab={activeTab === 'paused'}
        />
      </section>
    </div>
  );
}
