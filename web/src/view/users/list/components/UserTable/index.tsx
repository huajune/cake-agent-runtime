import { formatTime, formatDateTime } from '@/utils/format';
import type { UserTableProps } from '../../types';
import { AVATAR_GRADIENTS } from '../../constants';
import { getAvatarStyle, getUserInitial } from '../../utils/helpers';
import styles from './index.module.scss';

export default function UserTable({ users, isLoading, onToggleHosting, isPausedTab = false }: UserTableProps) {
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>用户</th>
            <th>会话</th>
            {!isPausedTab && <th>消息数</th>}
            {!isPausedTab && <th>Token 消耗</th>}
            {!isPausedTab && <th>首次活跃</th>}
            {!isPausedTab && <th>最后活跃</th>}
            {isPausedTab && <th>禁止时间</th>}
            <th>托管状态</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td colSpan={isPausedTab ? 4 : 7} className={styles.loadingCell}>
                <div className={styles.emptyStateContainer}>
                  <div className={styles.spinner} />
                  <p>加载中...</p>
                </div>
              </td>
            </tr>
          ) : users.length === 0 ? (
            <tr>
              <td colSpan={isPausedTab ? 4 : 7} className={styles.loadingCell}>
                <div className={styles.emptyStateContainer}>
                  <div className={styles.emptyIconWrapper}>
                    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={styles.emptyIcon}>
                      <circle cx="32" cy="32" r="31" stroke="#E6EFF5" strokeWidth="2" fill="none" />
                      <path d="M22 20H42C44.2 20 46 21.8 46 24V44H18V24C18 21.8 19.8 20 22 20Z" fill="white" stroke="#A3AED0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M26 28H38" stroke="#D8E3F0" strokeWidth="2" strokeLinecap="round" />
                      <path d="M26 34H38" stroke="#D8E3F0" strokeWidth="2" strokeLinecap="round" />
                      <circle cx="42" cy="24" r="2.5" fill="#FF7596" />
                    </svg>
                  </div>
                  <p>暂无数据</p>
                </div>
              </td>
            </tr>
          ) : (
            users.map((user) => (
              <tr key={user.chatId}>
                <td>
                  <div className={styles.userCell}>
                    <div className={styles.avatar} style={getAvatarStyle(user.odName || user.chatId, AVATAR_GRADIENTS)}>
                      {getUserInitial(user.odName || user.chatId)}
                    </div>
                    <span>{user.odName || '未知用户'}</span>
                  </div>

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
                <td>
                  <label className={styles.toggleSwitch}>
                    <input
                      type="checkbox"
                      checked={!user.isPaused}
                      onChange={(e) => onToggleHosting(user.chatId, e.target.checked)}
                    />
                    <span className={`${styles.statusText} ${!user.isPaused ? styles.enabled : styles.disabled}`}>
                      {!user.isPaused ? '已托管' : '已暂停'}
                    </span>
                  </label>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
