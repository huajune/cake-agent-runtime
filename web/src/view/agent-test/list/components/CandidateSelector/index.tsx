import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Users, Search, ChevronDown, Clock, MessageSquare, User, Loader2 } from 'lucide-react';
import {
  useChatSessionsOptimized,
  useChatSessionMessages,
  type ChatSession,
  type ChatMessage,
} from '@/hooks/chat/useChatSessions';
import styles from './index.module.scss';

export interface CandidateSelectorProps {
  onSelectHistory: (historyText: string) => void;
}

// 获取近7天的日期范围
function getLast7DaysRange(): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = now.toISOString().split('T')[0];
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 6);
  return { startDate: startDate.toISOString().split('T')[0], endDate };
}

// 格式化时间戳为 [MM/DD HH:mm] 格式
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `[${month}/${day} ${hours}:${minutes}`;
}

// 将消息列表转换为历史记录文本格式
function formatMessagesToHistory(messages: ChatMessage[], session: ChatSession): string {
  return messages
    .map((msg) => {
      const time = formatTimestamp(msg.timestamp);
      const name = msg.role === 'user' ? (session.candidateName || '候选人') : (session.managerName || '招募经理');
      return `${time} ${name}] ${msg.content}`;
    })
    .join('\n');
}

/**
 * 候选人选择器组件
 * 从近7天的真实对话中选择，自动填充到历史聊天记录
 */
export function CandidateSelector({ onSelectHistory }: CandidateSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [loadingChatId, setLoadingChatId] = useState<string | null>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);

  // 计算下拉框位置
  const updateDropdownPosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 8,
        left: Math.max(8, rect.right - 380), // 380px 是下拉框宽度，确保不超出左边界
      });
    }
  }, []);

  // 打开时计算位置
  useEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
      window.addEventListener('scroll', updateDropdownPosition, true);
      window.addEventListener('resize', updateDropdownPosition);
      return () => {
        window.removeEventListener('scroll', updateDropdownPosition, true);
        window.removeEventListener('resize', updateDropdownPosition);
      };
    }
  }, [isOpen, updateDropdownPosition]);

  // 获取近7天会话列表
  const { startDate, endDate } = getLast7DaysRange();
  const { data: sessionsData, isLoading: sessionsLoading } = useChatSessionsOptimized(startDate, endDate);

  // 获取选中会话的消息
  const { data: messagesData, isLoading: messagesLoading } = useChatSessionMessages(selectedChatId);

  // 过滤会话列表
  const filteredSessions = useMemo(() => {
    const sessions = sessionsData?.sessions || [];
    if (!searchTerm.trim()) return sessions;
    const term = searchTerm.toLowerCase();
    return sessions.filter(
      (s) =>
        s.candidateName?.toLowerCase().includes(term) ||
        s.managerName?.toLowerCase().includes(term) ||
        s.lastMessage?.toLowerCase().includes(term)
    );
  }, [sessionsData?.sessions, searchTerm]);

  // 处理会话选择
  const handleSelectSession = async (session: ChatSession) => {
    setLoadingChatId(session.chatId);
    setSelectedChatId(session.chatId);
  };

  // 当消息加载完成时，填充历史记录
  useEffect(() => {
    if (messagesData?.messages && selectedChatId && !messagesLoading && loadingChatId === selectedChatId) {
      const session = filteredSessions.find((s) => s.chatId === selectedChatId);

      if (session && messagesData.messages.length > 0) {
        const historyText = formatMessagesToHistory(messagesData.messages, session);
        onSelectHistory(historyText);
        setIsOpen(false);
        setSelectedChatId(null);
        setLoadingChatId(null);
      }
    }
  }, [messagesData, selectedChatId, messagesLoading, loadingChatId, filteredSessions, onSelectHistory]);

  // 格式化最后消息时间
  const formatLastTime = (timestamp?: number) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) {
      return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else if (diffDays === 1) {
      return '昨天';
    } else {
      return `${diffDays}天前`;
    }
  };

  return (
    <div className={styles.candidateSelector}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.selectorTrigger}
        onClick={() => setIsOpen(!isOpen)}
        disabled={sessionsLoading}
      >
        <Users size={14} />
        <span>选择真实对话</span>
        {sessionsLoading ? (
          <Loader2 size={14} className={styles.spinning} />
        ) : (
          <ChevronDown size={14} className={isOpen ? styles.rotated : ''} />
        )}
      </button>

      {/* 使用 Portal 渲染下拉框到 body，避免被父容器遮挡 */}
      {isOpen && createPortal(
        <>
          <div
            className={styles.selectorBackdrop}
            onClick={() => setIsOpen(false)}
          />
          <div
            className={styles.selectorDropdown}
            style={{ top: dropdownPos.top, left: dropdownPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.dropdownHeader}>
              <div className={styles.searchBox}>
                <Search size={14} />
                <input
                  type="text"
                  placeholder="搜索候选人或消息..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <span className={styles.dateRange}>近 7 天</span>
            </div>

            <div className={styles.sessionList}>
              {filteredSessions.length === 0 ? (
                <div className={styles.emptyList}>
                  {sessionsLoading ? '加载中...' : '暂无对话记录'}
                </div>
              ) : (
                filteredSessions.map((session) => (
                  <button
                    key={session.chatId}
                    type="button"
                    className={styles.sessionItem}
                    onClick={() => handleSelectSession(session)}
                    disabled={loadingChatId === session.chatId}
                  >
                    <div className={styles.sessionAvatar}>
                      {session.avatar ? (
                        <img src={session.avatar} alt="" />
                      ) : (
                        <User size={16} />
                      )}
                    </div>
                    <div className={styles.sessionInfo}>
                      <div className={styles.sessionName}>
                        <span>{session.candidateName || '未知候选人'}</span>
                        {session.managerName && (
                          <span className={styles.managerBadge}>@{session.managerName}</span>
                        )}
                      </div>
                      <div className={styles.sessionPreview}>
                        {session.lastMessage?.slice(0, 30) || '暂无消息'}
                        {(session.lastMessage?.length || 0) > 30 ? '...' : ''}
                      </div>
                    </div>
                    <div className={styles.sessionMeta}>
                      <span className={styles.sessionTime}>
                        <Clock size={10} />
                        {formatLastTime(session.lastTimestamp)}
                      </span>
                      <span className={styles.sessionCount}>
                        <MessageSquare size={10} />
                        {session.messageCount}
                      </span>
                    </div>
                    {loadingChatId === session.chatId && (
                      <Loader2 size={14} className={styles.spinning} />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
