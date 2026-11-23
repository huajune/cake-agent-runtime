import {
  useBlacklist,
  useAddToBlacklist,
  useRemoveFromBlacklist,
  useAiReplyStatus,
  useToggleAiReply,
} from '@/hooks/config/useSystemConfig';
import { useGroupList } from '@/hooks/config/useWorker';
import { DEFAULT_HENAN_GROUP_MARKER } from '../../../../../src/types/hosting-group';

// 组件导入
import { useDashboardAccess } from '@/hooks/useDashboardAccess';
import GlobalSwitch from './components/GlobalSwitch';
import GroupTable from './components/GroupTable';
import InfoCard from './components/InfoCard';
import { summarizeHostingGroups } from './group-sections';

// 样式导入
import styles from './styles/index.module.scss';

export default function Hosting() {
  const access = useDashboardAccess();
  const henanMarker = access?.henanGroupMarker ?? DEFAULT_HENAN_GROUP_MARKER;
  // 数据 hooks
  const blacklist = useBlacklist();
  const groupList = useGroupList();
  const addToBlacklist = useAddToBlacklist();
  const removeFromBlacklist = useRemoveFromBlacklist();
  const { data: aiStatus } = useAiReplyStatus(true, Boolean(access?.isAdministrator));
  const toggleAiReply = useToggleAiReply();

  const summary = summarizeHostingGroups(
    groupList.data ?? [],
    blacklist.data?.groupIds ?? [],
    henanMarker,
    access,
  );

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
      {access?.isAdministrator && (
        <GlobalSwitch
          enabled={aiStatus?.enabled ?? false}
          isPending={toggleAiReply.isPending}
          onToggle={(enabled) => toggleAiReply.mutate(enabled)}
        />
      )}

      {/* 小组托管管理 */}
      <GroupTable
        summary={summary}
        isLoading={groupList.isLoading || blacklist.isLoading}
        isError={groupList.isError || blacklist.isError}
        onRetry={() => {
          if (groupList.isError) void groupList.refetch();
          if (blacklist.isError) void blacklist.refetch();
        }}
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
