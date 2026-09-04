import styles from './index.module.scss';

interface GroupWithStatus {
  id: string;
  name: string;
  description?: string;
  isBlacklisted: boolean;
}

interface GroupTableProps {
  groups: GroupWithStatus[];
  blacklistCount: number;
  isLoading: boolean;
  isPending: boolean;
  onToggleBlacklist: (groupId: string, remove: boolean) => void;
}

export default function GroupTable({
  groups,
  blacklistCount,
  isLoading,
  isPending,
  onToggleBlacklist,
}: GroupTableProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>
          小组托管状态{' '}
          <span className={styles.headerCount}>
            ({groups.length} 个小组，{blacklistCount} 个已屏蔽)
          </span>
        </h3>
        <p className={styles.sectionDesc}>
          关闭托管后，该小组的消息不会触发 AI 回复，但仍会记录聊天历史
        </p>
      </div>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>小组名称</th>
              <th>描述</th>
              <th>托管状态</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={3} className={styles.loadingCell}>
                  加载中...
                </td>
              </tr>
            ) : groups.length === 0 ? (
              <tr>
                <td colSpan={3} className={styles.loadingCell}>
                  暂无小组数据
                </td>
              </tr>
            ) : (
              groups.map((group) => (
                <tr key={group.id}>
                  <td>
                    <div className={styles.groupName}>{group.name}</div>
                    <div className={styles.groupId}>{group.id}</div>
                  </td>
                  <td className={styles.groupDesc}>
                    {group.description || '-'}
                  </td>
                  <td>
                    <label className={styles.toggleSwitch}>
                      <input
                        type="checkbox"
                        checked={!group.isBlacklisted}
                        onChange={(e) => onToggleBlacklist(group.id, e.target.checked)}
                        disabled={isPending}
                      />
                      <span
                        className={`${styles.statusText} ${!group.isBlacklisted ? styles.enabled : styles.disabled}`}
                      >
                        {group.isBlacklisted ? '已屏蔽' : '托管中'}
                      </span>
                    </label>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
