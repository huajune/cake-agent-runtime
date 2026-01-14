import { CheckCircle2, XCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ConversationTurnExecution } from '../../types';
import styles from './index.module.scss';

interface TurnCompareViewProps {
  turns: ConversationTurnExecution[];
  conversationInfo: {
    id: string;
    participantName: string | null;
    totalTurns: number;
    avgSimilarityScore: number | null;
  } | null;
  currentTurnIndex: number;
  loading: boolean;
  onTurnChange: (index: number) => void;
  onReview?: (turnId: string, status: 'passed' | 'failed', comment?: string) => void;
}

/**
 * 对话轮次对比视图
 * 展示单个轮次的输入、期望输出、实际输出和相似度对比
 */
export function TurnCompareView({
  turns,
  conversationInfo,
  currentTurnIndex,
  loading,
  onTurnChange,
  onReview,
}: TurnCompareViewProps) {
  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>加载中...</div>
      </div>
    );
  }

  if (!conversationInfo || turns.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>暂无轮次数据</div>
      </div>
    );
  }

  const currentTurn = turns[currentTurnIndex];
  const hasPrev = currentTurnIndex > 0;
  const hasNext = currentTurnIndex < turns.length - 1;

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
   * 获取相似度评级
   */
  const getRating = (score: number | null) => {
    if (!score) return '--';
    if (score >= 80) return '优秀 (80-100)';
    if (score >= 60) return '良好 (60-79)';
    if (score >= 40) return '一般 (40-59)';
    return '较差 (0-39)';
  };

  return (
    <div className={styles.container}>
      {/* 头部：对话信息和轮次导航 */}
      <div className={styles.header}>
        <div className={styles.conversationInfo}>
          <h3>{conversationInfo.participantName || '未知参与者'}</h3>
          <span className={styles.avgScore}>
            平均相似度: {conversationInfo.avgSimilarityScore?.toFixed(1) || '--'}%
          </span>
        </div>
        <div className={styles.navigation}>
          <button
            className={styles.navBtn}
            onClick={() => onTurnChange(currentTurnIndex - 1)}
            disabled={!hasPrev}
          >
            <ChevronLeft size={16} />
          </button>
          <span className={styles.turnIndicator}>
            第 {currentTurn.turnNumber} 轮 / 共 {conversationInfo.totalTurns} 轮
          </span>
          <button
            className={styles.navBtn}
            onClick={() => onTurnChange(currentTurnIndex + 1)}
            disabled={!hasNext}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* 主体：对比内容 */}
      <div className={styles.body}>
        {/* 用户输入 */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h4>用户消息</h4>
          </div>
          <div className={styles.messageBox}>
            <p className={styles.message}>{currentTurn.inputMessage}</p>
          </div>
        </div>

        {/* 对比区域 */}
        <div className={styles.compareSection}>
          {/* 期望输出 */}
          <div className={styles.compareBox}>
            <div className={styles.compareHeader}>
              <h4>真人回复（期望）</h4>
            </div>
            <div className={styles.messageBox}>
              <p className={styles.message}>{currentTurn.expectedOutput || '--'}</p>
            </div>
          </div>

          {/* 实际输出 */}
          <div className={styles.compareBox}>
            <div className={styles.compareHeader}>
              <h4>Agent 回复（实际）</h4>
            </div>
            <div className={styles.messageBox}>
              <p className={styles.message}>{currentTurn.actualOutput || '--'}</p>
            </div>
          </div>
        </div>

        {/* 相似度分析 */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h4>相似度分析</h4>
          </div>
          <div className={styles.scorePanel}>
            <div className={styles.scoreDisplay}>
              <span className={styles.scoreLabel}>相似度分数</span>
              <span
                className={`${styles.scoreValue} ${getScoreClassName(currentTurn.similarityScore)}`}
              >
                {currentTurn.similarityScore !== null ? `${currentTurn.similarityScore}%` : '--'}
              </span>
            </div>
            <div className={styles.scoreRating}>
              <span className={styles.ratingLabel}>评级</span>
              <span className={styles.ratingValue}>
                {getRating(currentTurn.similarityScore)}
              </span>
            </div>
          </div>
        </div>

        {/* 元数据 */}
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h4>执行信息</h4>
          </div>
          <div className={styles.metadataGrid}>
            <div className={styles.metadataItem}>
              <span className={styles.metaLabel}>执行状态</span>
              <span className={styles.metaValue}>
                {currentTurn.executionStatus === 'success' ? (
                  <span className={styles.statusSuccess}>
                    <CheckCircle2 size={14} />
                    成功
                  </span>
                ) : (
                  <span className={styles.statusFailed}>
                    <XCircle size={14} />
                    失败
                  </span>
                )}
              </span>
            </div>
            <div className={styles.metadataItem}>
              <span className={styles.metaLabel}>耗时</span>
              <span className={styles.metaValue}>
                {currentTurn.durationMs ? `${currentTurn.durationMs}ms` : '--'}
              </span>
            </div>
            <div className={styles.metadataItem}>
              <span className={styles.metaLabel}>Token 使用</span>
              <span className={styles.metaValue}>
                {currentTurn.tokenUsage?.totalTokens || '--'}
              </span>
            </div>
            <div className={styles.metadataItem}>
              <span className={styles.metaLabel}>评审状态</span>
              <span className={styles.metaValue}>{currentTurn.reviewStatus || 'pending'}</span>
            </div>
          </div>
        </div>

        {/* 评审备注 */}
        {currentTurn.reviewComment && (
          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h4>评审备注</h4>
            </div>
            <div className={styles.commentBox}>
              <p>{currentTurn.reviewComment}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
