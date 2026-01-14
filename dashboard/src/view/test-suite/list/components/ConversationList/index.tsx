import { Play, CheckCircle2, XCircle, Clock, User } from 'lucide-react';
import type { ConversationSource } from '../../types';
import styles from './index.module.scss';

interface ConversationListProps {
  conversations: ConversationSource[];
  selectedConversation: ConversationSource | null;
  loading: boolean;
  onSelect: (conversation: ConversationSource) => void;
  onExecute: (conversationId: string) => void;
  executing?: string | null;
}

/**
 * 对话验证列表组件
 * 显示所有对话源记录，支持选择和执行
 */
export function ConversationList({
  conversations,
  selectedConversation,
  loading,
  onSelect,
  onExecute,
  executing,
}: ConversationListProps) {
  /**
   * 获取状态图标
   */
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 size={16} className={styles.statusCompleted} />;
      case 'failed':
        return <XCircle size={16} className={styles.statusFailed} />;
      case 'running':
        return <Clock size={16} className={styles.statusRunning} />;
      default:
        return <Clock size={16} className={styles.statusPending} />;
    }
  };

  /**
   * 获取相似度分数样式类名
   */
  const getScoreClassName = (score: number | null) => {
    if (!score) return '';
    if (score >= 80) return styles.scoreExcellent;
    if (score >= 60) return styles.scoreGood;
    if (score >= 40) return styles.scoreFair;
    return styles.scorePoor;
  };

  /**
   * 获取相似度评级文本
   */
  const getRatingText = (score: number | null) => {
    if (!score) return '--';
    if (score >= 80) return '优秀';
    if (score >= 60) return '良好';
    if (score >= 40) return '一般';
    return '较差';
  };

  if (loading && conversations.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>加载中...</div>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          <p>暂无对话验证记录</p>
          <span className={styles.emptyHint}>请先从飞书同步对话测试数据</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.list}>
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`${styles.card} ${
              selectedConversation?.id === conversation.id ? styles.selected : ''
            }`}
            onClick={() => onSelect(conversation)}
          >
            {/* 头部：参与者信息 */}
            <div className={styles.cardHeader}>
              <div className={styles.participant}>
                <User size={16} className={styles.userIcon} />
                <span className={styles.name}>
                  {conversation.participantName || '未知参与者'}
                </span>
              </div>
              <div className={styles.status}>{getStatusIcon(conversation.status)}</div>
            </div>

            {/* 主体：统计信息 */}
            <div className={styles.cardBody}>
              <div className={styles.stat}>
                <span className={styles.statLabel}>总轮数</span>
                <span className={styles.statValue}>{conversation.totalTurns}</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>平均相似度</span>
                <span
                  className={`${styles.statValue} ${getScoreClassName(conversation.avgSimilarityScore)}`}
                >
                  {conversation.avgSimilarityScore !== null
                    ? `${conversation.avgSimilarityScore}%`
                    : '--'}
                </span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statLabel}>评级</span>
                <span className={styles.statValue}>
                  {getRatingText(conversation.avgSimilarityScore)}
                </span>
              </div>
            </div>

            {/* 底部：操作按钮 */}
            <div className={styles.cardFooter}>
              <span className={styles.conversationId}>
                #{conversation.conversationId.slice(-8)}
              </span>
              <button
                className={styles.executeBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onExecute(conversation.id);
                }}
                disabled={executing === conversation.id || conversation.status === 'running'}
              >
                {executing === conversation.id ? (
                  <>
                    <Clock size={14} className={styles.spinning} />
                    执行中...
                  </>
                ) : (
                  <>
                    <Play size={14} />
                    执行测试
                  </>
                )}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
