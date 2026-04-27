import { Bot, Inbox } from 'lucide-react';
import { formatDateTime, formatNumber, formatRelativeTime, formatTime } from '@/utils/format';
import type { UserTableProps } from '../../types';
import { AVATAR_GRADIENTS } from '../../constants';
import { getAvatarStyle, getUserInitial } from '../../utils/helpers';
import styles from './index.module.scss';

const COLUMN_COUNT = 6;

function getBotLabel(user: { botUserId?: string; imBotId?: string }) {
  return user.botUserId || user.imBotId || '未知 bot';
}

export default function UserTable({
  users,
  isLoading,
  onToggleHosting,
  isPausedTab = false,
  pendingChatId,
  emptyMessage = '暂无数据',
}: UserTableProps) {
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>用户</th>
            <th>托管 bot</th>
            <th>会话</th>
            {!isPausedTab && <th>活跃时间</th>}
            {!isPausedTab && <th>今日统计</th>}
            {isPausedTab && <th>禁止时间</th>}
            {isPausedTab && <th>解禁时间</th>}
            <th>托管状态</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td colSpan={COLUMN_COUNT} className={styles.loadingCell}>
                <div className={styles.emptyStateContainer}>
                  <div className={styles.spinner} />
                  <p>加载中...</p>
                </div>
              </td>
            </tr>
          ) : users.length === 0 ? (
            <tr>
              <td colSpan={COLUMN_COUNT} className={styles.loadingCell}>
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
                      <div className={styles.userMeta}>
                        <span className={styles.userName}>{user.odName || '未知用户'}</span>
                        <span className={styles.userSubline}>{user.groupName || '未识别群组'}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className={styles.botCell}>
                      <div className={styles.botLabel}>
                        <Bot size={14} aria-hidden="true" />
                        <span>{botLabel}</span>
                      </div>
                      {user.imBotId && user.imBotId !== botLabel && (
                        <span className={styles.botId}>{user.imBotId}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div className={styles.chatCell}>
                      <code>{user.chatId}</code>
                      <span>{user.groupName ? '群聊' : '会话'}</span>
                    </div>
                  </td>
                  {!isPausedTab && (
                    <td>
                      <div className={styles.timeCell}>
                        <strong>{formatRelativeTime(user.lastActiveAt)}</strong>
                        <span>最后 {formatTime(user.lastActiveAt)}</span>
                        <span>首次 {formatTime(user.firstActiveAt)}</span>
                      </div>
                    </td>
                  )}
                  {!isPausedTab && (
                    <td>
                      <div className={styles.metricsCell}>
                        <strong>{formatNumber(user.messageCount)}</strong>
                        <span>{formatNumber(user.tokenUsage)} tokens</span>
                      </div>
                    </td>
                  )}
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
