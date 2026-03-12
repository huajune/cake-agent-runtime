import { MessageSquare, ChevronRight, Check, X, Clock, Loader2, Play } from 'lucide-react';
import type { ConversationSnapshot } from '../../types';
import { getScoreStyleClass } from '../../utils';
import styles from './index.module.scss';

interface ConversationListProps {
  conversations: ConversationSnapshot[];
  selectedConversation: ConversationSnapshot | null;
  loading: boolean;
  onSelect: (conversation: ConversationSnapshot) => void;
  onExecute: (conversationId: string) => void;
  executing?: string | null;
}

// 执行状态图标配置
const getStatusConfig = (status: string) => {
  const config: Record<string, { icon: typeof Check; className: string; title: string }> = {
    completed: { icon: Check, className: 'statusCompleted', title: '执行完成' },
    failed: { icon: X, className: 'statusFailed', title: '执行失败' },
    running: { icon: Loader2, className: 'statusRunning', title: '执行中' },
    pending: { icon: Clock, className: 'statusPending', title: '待执行' },
  };
  return config[status] || config.pending;
};

/**
 * 回归验证列表组件
 * 与 CaseList 保持一致的视觉风格
 */
export function ConversationList({
  conversations,
  selectedConversation,
  loading,
  onSelect,
  onExecute,
  executing,
}: ConversationListProps) {
  if (loading && conversations.length === 0) {
    return (
      <>
        <div className={styles.listHeader}>
          <h4>
            <MessageSquare size={16} /> 回归验证
          </h4>
          <span className={styles.itemCount}>加载中...</span>
        </div>
        <div className={styles.list}>
          <div className={styles.loading}>加载中...</div>
        </div>
      </>
    );
  }

  if (conversations.length === 0) {
    return (
      <>
        <div className={styles.listHeader}>
          <h4>
            <MessageSquare size={16} /> 回归验证
          </h4>
          <span className={styles.itemCount}>共 0 条</span>
        </div>
        <div className={styles.list}>
          <div className={styles.empty}>
            <p>暂无回归验证记录</p>
            <span>请先从飞书同步回归验证数据</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={styles.listHeader}>
        <h4>
          <MessageSquare size={16} /> 回归验证
        </h4>
        <span className={styles.itemCount}>共 {conversations.length} 条</span>
      </div>

      <div className={styles.list}>
        {conversations.map((conversation, index) => {
          const statusConfig = getStatusConfig(conversation.status);
          const StatusIcon = statusConfig.icon;
          const isSelected = selectedConversation?.id === conversation.id;
          const isExecuting = executing === conversation.id;

          return (
            <div
              key={conversation.id}
              className={`${styles.item} ${isSelected ? styles.selected : ''}`}
              onClick={() => onSelect(conversation)}
            >
              <div className={styles.itemIndex}>{index + 1}</div>
              <div className={styles.itemContent}>
                <div className={styles.itemNameRow}>
                  <span className={styles.itemName}>
                    {conversation.participantName || '未知参与者'}
                  </span>
                </div>
                <div className={styles.itemMeta}>
                  共 {conversation.totalTurns} 轮对话
                </div>
              </div>
              <div className={styles.itemStatus}>
                <div className={styles.statusGroup} title={`评分: ${conversation.avgSimilarityScore ?? '--'}分`}>
                  <span className={styles.statusLabel}>评分</span>
                  <span className={`${styles.scoreTag} ${styles[getScoreStyleClass(conversation.avgSimilarityScore)]}`}>
                    {conversation.avgSimilarityScore !== null
                      ? `${conversation.avgSimilarityScore}分`
                      : '--'}
                  </span>
                </div>
                <div className={styles.statusGroup} title={statusConfig.title}>
                  <span className={styles.statusLabel}>状态</span>
                  <span className={`${styles.statusIcon} ${styles[statusConfig.className]}`}>
                    <StatusIcon size={12} />
                  </span>
                </div>
                <button
                  className={styles.executeBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onExecute(conversation.id);
                  }}
                  disabled={isExecuting || conversation.status === 'running'}
                  title="执行测试"
                >
                  {isExecuting ? (
                    <Loader2 size={12} className={styles.spinning} />
                  ) : (
                    <Play size={12} />
                  )}
                </button>
                <ChevronRight size={14} className={styles.chevron} />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export default ConversationList;
