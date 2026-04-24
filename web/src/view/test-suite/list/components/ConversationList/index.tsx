import { MessageSquare, ChevronRight, Check, X, Clock, Loader2, Play } from 'lucide-react';
import type { ConversationSnapshot } from '../../types';
import { formatScore, getScoreStyleClass } from '../../utils';
import styles from './index.module.scss';

interface ConversationListProps {
  conversations: ConversationSnapshot[];
  selectedConversation: ConversationSnapshot | null;
  loading: boolean;
  total?: number;
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

const GENERIC_PARTICIPANT_NAMES = new Set(['测试用户', '未知参与者']);

const getConversationTitle = (conversation: ConversationSnapshot): string => {
  const validationTitle = conversation.validationTitle?.trim();
  if (validationTitle) {
    return validationTitle;
  }

  const participantName = conversation.participantName?.trim();
  if (participantName && !GENERIC_PARTICIPANT_NAMES.has(participantName)) {
    return participantName;
  }

  return '未命名验证';
};

const getConversationMeta = (conversation: ConversationSnapshot): string => {
  const participantName = conversation.participantName?.trim();
  const segments =
    participantName && !GENERIC_PARTICIPANT_NAMES.has(participantName) ? [participantName] : [];
  segments.push(`共 ${conversation.totalTurns} 轮对话`);
  if (conversation.avgSimilarityScore !== null) {
    segments.push(`评分 ${formatScore(conversation.avgSimilarityScore)}`);
  }
  if (conversation.minSimilarityScore !== null) {
    segments.push(`最低 ${formatScore(conversation.minSimilarityScore)}`);
  }
  return segments.join(' · ');
};

/**
 * 回归验证列表组件
 * 与 CaseList 保持一致的视觉风格
 */
export function ConversationList({
  conversations,
  selectedConversation,
  loading,
  total,
  onSelect,
  onExecute,
  executing,
}: ConversationListProps) {
  const safeConversations = Array.isArray(conversations) ? conversations : [];
  const totalCount = typeof total === 'number' && total > 0 ? total : safeConversations.length;
  const countLabel =
    totalCount > safeConversations.length
      ? `已加载 ${safeConversations.length}/${totalCount} 条`
      : `共 ${totalCount} 条`;

  if (loading && safeConversations.length === 0) {
    return (
      <>
        <div className={styles.listHeader}>
          <h4>
            <MessageSquare size={16} /> 回归验证
          </h4>
        </div>
        <div className={styles.list}>
          <div className={styles.loading}>加载中...</div>
        </div>
      </>
    );
  }

  if (safeConversations.length === 0) {
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
        <span className={styles.itemCount}>{countLabel}</span>
      </div>

      <div className={styles.list}>
        {safeConversations.map((conversation, index) => {
          const statusConfig = getStatusConfig(conversation.status);
          const StatusIcon = statusConfig.icon;
          const isSelected = selectedConversation?.id === conversation.id;
          const isExecuting = executing === conversation.id;
          const title = getConversationTitle(conversation);
          const meta = getConversationMeta(conversation);

          return (
            <div
              key={conversation.id}
              className={`${styles.item} ${isSelected ? styles.selected : ''}`}
              onClick={() => onSelect(conversation)}
            >
              <div className={styles.itemIndex}>{index + 1}</div>
              <div className={styles.itemContent}>
                <div className={styles.itemNameRow}>
                  <span className={styles.itemName} title={title}>
                    {title}
                  </span>
                </div>
                <div className={styles.itemMeta}>{meta}</div>
              </div>
              <div className={styles.itemStatus}>
                <div
                  className={styles.statusGroup}
                  title={`平均评分: ${formatScore(conversation.avgSimilarityScore)}`}
                >
                  <span className={styles.statusLabel}>评分</span>
                  <span
                    className={`${styles.scoreTag} ${styles[getScoreStyleClass(conversation.avgSimilarityScore)]}`}
                  >
                    {formatScore(conversation.avgSimilarityScore)}
                  </span>
                </div>
                <div
                  className={styles.statusGroup}
                  title={`最低评分: ${formatScore(conversation.minSimilarityScore)}`}
                >
                  <span className={styles.statusLabel}>最低</span>
                  <span
                    className={`${styles.scoreTag} ${styles[getScoreStyleClass(conversation.minSimilarityScore)]}`}
                  >
                    {formatScore(conversation.minSimilarityScore)}
                  </span>
                </div>
                <div className={styles.statusGroup} title={statusConfig.title}>
                  <span className={styles.statusLabel}>状态</span>
                  <span className={`${styles.statusIcon} ${styles[statusConfig.className]}`}>
                    <StatusIcon size={12} />
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.executeBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onExecute(conversation.id);
                  }}
                  disabled={isExecuting || conversation.status === 'running'}
                  title="执行测试"
                  aria-label={`执行 ${title} 的回归验证`}
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
