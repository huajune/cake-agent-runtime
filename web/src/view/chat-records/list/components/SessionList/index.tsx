import { useEffect, useRef } from 'react';
import type { ChatSession } from '@/hooks/chat/useChatSessions';
import { formatLocaleDateTime } from '@/utils/format';
import styles from './index.module.scss';

// 客户类型标签映射
const CONTACT_TYPE_LABELS: Record<string, { label: string; className: string }> = {
  PERSONAL_WECHAT: { label: '个微', className: 'personal' },
  ENTERPRISE_WECHAT: { label: '企微', className: 'enterprise' },
  OFFICIAL_ACCOUNT: { label: '公众号', className: 'official' },
  UNKNOWN: { label: '', className: 'unknown' },
};

// 格式化时间戳
function formatTime(timestamp: number): string {
  return formatLocaleDateTime(timestamp, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SessionListProps {
  sessions: ChatSession[];
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  isLoading: boolean;
  timeRangeLabel: string;
  /** 刚收到新消息的会话（Realtime 推送），用于高亮闪烁 */
  activeChatIds?: Set<string>;
  /** 时间窗内的会话总数（服务端返回，非已加载条数） */
  total: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

export default function SessionList({
  sessions,
  selectedChatId,
  onSelectChat,
  searchTerm,
  onSearchChange,
  isLoading,
  timeRangeLabel,
  activeChatIds,
  total,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: SessionListProps) {
  // 搜索已下推到服务端（命中整个时间窗，而不只是已加载的页），这里直接渲染
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 滚动到底部自动加载下一页。
  // root 必须绑到列表容器：列表在自己的 overflow 容器里滚动，用默认的 viewport 作 root
  // 在容器不可见 / 视口高度为 0 时永远不会触发。
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { root, rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onLoadMore, sessions.length]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <h3 className={styles.title}>会话列表</h3>
          <span className={styles.count} title={`已加载 ${sessions.length} / 共 ${total}`}>
            {sessions.length < total ? `${sessions.length} / ${total}` : total}
          </span>
        </div>

        <div className={styles.searchWrapper}>
          <span className={styles.searchIcon}>🔍</span>
          <input
            className={styles.searchInput}
            type="text"
            placeholder="搜索候选人 / 招聘经理 / 消息..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.listContainer} ref={listRef}>
        {isLoading ? (
          <div className={styles.stateContainer}>
            <div className="loading-spinner"></div>
            加载中...
          </div>
        ) : sessions.length === 0 ? (
          <div className={styles.stateContainer}>
            <div className={styles.emptyIconWrapper}>
              <svg
                width="64"
                height="64"
                viewBox="0 0 64 64"
                fill="none"
                className={styles.emptyIcon}
              >
                <circle cx="32" cy="32" r="31" stroke="#E6EFF5" strokeWidth="2" fill="none" />
                <path
                  d="M16 26C16 23.7909 17.7909 22 20 22H44C46.2091 22 48 23.7909 48 26V42C48 44.2091 46.2091 46 44 46H20C17.7909 46 16 44.2091 16 42V26Z"
                  fill="white"
                  stroke="#A3AED0"
                  strokeWidth="2"
                />
                <path d="M32 36L16 26" stroke="#D8E3F0" strokeWidth="2" strokeLinecap="round" />
                <path d="M32 36L48 26" stroke="#D8E3F0" strokeWidth="2" strokeLinecap="round" />
                <path
                  d="M42 22V18C42 16.8954 41.1046 16 40 16H36C34.8954 16 34 16.8954 34 18V22"
                  stroke="#A3AED0"
                  strokeWidth="2"
                />
                <circle cx="44" cy="22" r="3" fill="#FF7596" />
              </svg>
            </div>
            <p>{searchTerm ? `没有匹配「${searchTerm}」的会话` : `${timeRangeLabel}暂无会话记录`}</p>
          </div>
        ) : (
          sessions.map((session) => {
            const contactTypeInfo = CONTACT_TYPE_LABELS[session.contactType || 'UNKNOWN'];
            const avatarChar = (session.candidateName || session.chatId || '?')
              .charAt(0)
              .toUpperCase();

            return (
              <div
                key={session.chatId}
                className={`${styles.sessionItem} ${selectedChatId === session.chatId ? styles.active : ''} ${activeChatIds?.has(session.chatId) ? styles.flashing : ''}`}
                onClick={() => onSelectChat(session.chatId)}
              >
                {session.avatar ? (
                  <img
                    src={session.avatar}
                    alt={session.candidateName || '头像'}
                    className={styles.avatar}
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = 'none';
                      target.nextElementSibling?.classList.remove(styles.hidden);
                    }}
                  />
                ) : null}
                <div
                  className={`${styles.avatar} ${session.avatar ? styles.hidden : ''}`}
                  style={{ display: session.avatar ? 'none' : 'flex' }}
                >
                  {avatarChar}
                </div>

                <div className={styles.sessionContent}>
                  <div className={styles.topRow}>
                    <div className={styles.nameWrapper}>
                      <span
                        className={styles.candidateName}
                        title={session.candidateName || '未知候选人'}
                      >
                        {session.candidateName || '未知候选人'}
                      </span>
                      {contactTypeInfo.label && (
                        <span className={`contact-type-badge ${contactTypeInfo.className}`}>
                          {contactTypeInfo.label}
                        </span>
                      )}
                      {session.managerName && (
                        <span className={styles.managerBadge}>@{session.managerName}</span>
                      )}
                    </div>
                    <span className={styles.sessionTime}>
                      {session.lastTimestamp
                        ? formatTime(session.lastTimestamp).split(' ')[1]
                        : '-'}
                    </span>
                  </div>

                  <div className={styles.bottomRow}>
                    <span className={styles.preview}>{session.lastMessage || '暂无消息'}</span>
                    {session.messageCount > 0 && (
                      // key 随消息数变化 → 重新挂载 → 重放一次「跳动」动画（仅高亮态可见）
                      <span
                        key={`${session.chatId}-${session.messageCount}`}
                        className={styles.msgCountBadge}
                      >
                        {session.messageCount}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* 触底自动加载下一页；到末页后展示收尾提示 */}
        {!isLoading && sessions.length > 0 && (
          <div ref={sentinelRef} className={styles.loadMore}>
            {isFetchingNextPage ? (
              <>
                <div className="loading-spinner"></div>
                加载中...
              </>
            ) : hasNextPage ? (
              <button type="button" className={styles.loadMoreBtn} onClick={onLoadMore}>
                加载更多
              </button>
            ) : (
              <span className={styles.loadMoreEnd}>已显示全部 {total} 个会话</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
