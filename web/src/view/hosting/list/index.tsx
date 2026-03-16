import {
  useBlacklist,
  useAddToBlacklist,
  useRemoveFromBlacklist,
  useAiReplyStatus,
  useToggleAiReply,
} from '@/hooks/config/useSystemConfig';
import { useGroupList } from '@/hooks/config/useWorker';

// 组件导入
import GlobalSwitch from './components/GlobalSwitch';
import GroupTable from './components/GroupTable';
import InfoCard from './components/InfoCard';

// 样式导入
import styles from './styles/index.module.scss';

export default function Hosting() {
  // 数据 hooks
  const { data: blacklist, isLoading: isLoadingBlacklist } = useBlacklist();
  const { data: groupList, isLoading: isLoadingGroups } = useGroupList();
  const addToBlacklist = useAddToBlacklist();
  const removeFromBlacklist = useRemoveFromBlacklist();
  const { data: aiStatus } = useAiReplyStatus();
  const toggleAiReply = useToggleAiReply();

  // 计算小组状态（是否在黑名单中）
  const groupsWithStatus = (groupList || []).map((group) => ({
    ...group,
    isBlacklisted: (blacklist?.groupIds || []).includes(group.id),
  }));

  // 切换黑名单状态
  const handleToggleBlacklist = (groupId: string, remove: boolean) => {
    if (remove) {
      // 启用托管 = 从黑名单移除
      removeFromBlacklist.mutate({ id: groupId, type: 'groupId' });
    } else {
      // 禁用托管 = 添加到黑名单
      addToBlacklist.mutate({ id: groupId, type: 'groupId' });
    }
  };

  return (
    <div className={styles.page}>
      {/* 全局 AI 开关 */}
      <GlobalSwitch
        enabled={aiStatus?.enabled ?? false}
        isPending={toggleAiReply.isPending}
        onToggle={(enabled) => toggleAiReply.mutate(enabled)}
      />

      {/* 小组托管管理 */}
      <GroupTable
        groups={groupsWithStatus}
        blacklistCount={blacklist?.groupIds?.length || 0}
        isLoading={isLoadingGroups || isLoadingBlacklist}
        isPending={addToBlacklist.isPending || removeFromBlacklist.isPending}
        onToggleBlacklist={handleToggleBlacklist}
      />

      {/* 说明卡片 */}
      <section className={styles.section}>
        <InfoCard />
      </section>
    </div>
  );
}
