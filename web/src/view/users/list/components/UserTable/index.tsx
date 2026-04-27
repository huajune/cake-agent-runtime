import { Inbox } from 'lucide-react';
import { formatTime, formatDateTime } from '@/utils/format';
import type { UserTableProps } from '../../types';
import { AVATAR_GRADIENTS } from '../../constants';
import { getAvatarStyle, getUserInitial } from '../../utils/helpers';
import styles from './index.module.scss';

function getBotLabel(user: { botUserId?: string; imBotId?: string }) {
  return user.botUserId || user.imBotId || '-';
}

export default function UserTable({
  users,
  isLoading,
  onToggleHosting,
  isPausedTab = false,
  pendingChatId,
  emptyMessage = '暂无数据',
}: UserTableProps) {
  const columnCount = isPausedTab ? 6 : 8;

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>用户</th>
            <th>托管 bot</th>
            <th>会话ID</th>
            {!isPausedTab && <th>消息数</th>}
            {!isPausedTab && <th>Token 消耗</th>}
            {!isPausedTab && <th>首次活跃</th>}
            {!isPausedTab && <th>最后活跃</th>}
            {isPausedTab && <th>禁止时间</th>}
            {isPausedTab && <th>解禁时间</th>}
            <th>托管状态</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td colSpan={columnCount} className={styles.loadingCell}>
                <div className={styles.emptyStateContainer}>
                  <div className={styles.spinner} />
                  <p>加载中...</p>
                </div>
              </td>
            </tr>
          ) : users.length === 0 ? (
            <tr>
              <td colSpan={columnCount} className={styles.loadingCell}>
                <div className={styles.emptyStateContainer}>
                  <Inbox className={styles.emptyIcon} aria-hidden="true" />
                  <p>{emptyMessage}</p>
                </div>
              </td>
            </tr>
          ) : (
            users.map((user) => {
              const botLabel = getBotLabel(user);
              const isUpdating = pendingChatId === user.chatId;

              return (
                <tr key={user.chatId} className={isUpdating ? styles.updatingRow : undefined}>
                  <td>
                    <div className={styles.userCell}>
                      <div
                        className={styles.avatar}
                        style={getAvatarStyle(user.odName || user.chatId, AVATAR_GRADIENTS)}
                      >
                        {getUserInitial(user.odName || user.chatId)}
                      </div>
                      <span>{user.odName || '未知用户'}</span>
                    </div>
                  </td>
                  <td className={styles.botCell} title={user.imBotId || botLabel}>
                    {botLabel}
                  </td>
                  <td className={styles.chatIdCell}>
                    {user.chatId}
                    {user.groupName && <span className={styles.groupBadge}>群</span>}
                  </td>
                  {!isPausedTab && <td>{user.messageCount}</td>}
                  {!isPausedTab && <td>{user.tokenUsage}</td>}
                  {!isPausedTab && <td>{formatTime(user.firstActiveAt)}</td>}
                  {!isPausedTab && <td>{formatTime(user.lastActiveAt)}</td>}
                  {isPausedTab && <td>{formatDateTime(user.firstActiveAt)}</td>}
                  {isPausedTab && (
                    <td>{user.pauseExpiresAt ? formatDateTime(user.pauseExpiresAt) : '-'}</td>
                  )}
                  <td>
                    <label
                      className={`${styles.toggleSwitch} ${isUpdating ? styles.togglePending : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={!user.isPaused}
                        disabled={isUpdating}
                        onChange={(e) => onToggleHosting(user.chatId, e.target.checked)}
                      />
                      <span
                        className={`${styles.statusText} ${
                          !user.isPaused ? styles.enabled : styles.disabled
                        }`}
                      >
                        {isUpdating ? '处理中' : !user.isPaused ? '已托管' : '已暂停'}
                      </span>
                    </label>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
