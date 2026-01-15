import { useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  User,
  Bot,
  History,
  Wrench,
  MessageCircle,
} from 'lucide-react';
import type { ConversationSource, ConversationTurnExecution, ToolCall } from '../../types';
import { CompactMetrics } from './CompactMetrics';
import { HistoryMessage } from './HistoryMessage';
import { ToolCallItem } from './ToolCallItem';
import { LoadingSkeleton } from './LoadingSkeleton';
import styles from './index.module.scss';

interface ConversationDetailModalProps {
  conversation: ConversationSource;
  turns: ConversationTurnExecution[];
  currentTurnIndex: number;
  loading: boolean;
  onClose: () => void;
  onTurnChange: (index: number) => void;
}

/**
 * 对话验证详情弹窗
 * 参考 ExecutionDetailViewer 布局设计
 */
export function ConversationDetailModal({
  conversation,
  turns,
  currentTurnIndex,
  loading,
  onClose,
  onTurnChange,
}: ConversationDetailModalProps) {
  const [showHistory, setShowHistory] = useState(true);
  const [showToolCalls, setShowToolCalls] = useState(false);

  const currentTurn = turns[currentTurnIndex];
  const hasPrev = currentTurnIndex > 0;
  const hasNext = currentTurnIndex < turns.length - 1;

  // 获取历史轮次（当前轮次之前的所有轮次）
  const historyTurns = turns.slice(0, currentTurnIndex);

  // 获取工具调用（将 unknown[] 转换为 ToolCall[]）
  const toolCalls = (currentTurn?.toolCalls || []) as ToolCall[];

  return (
    <div className={styles.modal}>
      <div className={styles.modalContent}>
        {/* 头部 */}
        <div className={styles.modalHeader}>
          <div className={styles.headerInfo}>
            <div className={styles.participant}>
              <User size={18} />
              <h3>{conversation.participantName || '未知参与者'}</h3>
            </div>
            <div className={styles.headerMeta}>
              总轮数: {conversation.totalTurns} · 平均相似度:{' '}
              {conversation.avgSimilarityScore !== null
                ? `${conversation.avgSimilarityScore}%`
                : '--'}
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* 内容区 */}
        <div className={styles.modalBody}>
          {loading ? (
            <LoadingSkeleton />
          ) : turns.length === 0 ? (
            <div className={styles.empty}>
              <p>暂无轮次数据</p>
              <span>请先执行测试</span>
            </div>
          ) : currentTurn ? (
            <div className={styles.detailViewer}>
              {/* 顶部紧凑指标条 */}
              <CompactMetrics
                similarityScore={currentTurn.similarityScore}
                status={currentTurn.executionStatus}
                durationMs={currentTurn.durationMs}
              />

              {/* 主内容区：左右分栏 */}
              <div className={styles.mainContent}>
                {/* 左侧：输入区域 */}
                <div className={styles.inputPanel}>
                  {/* 用户输入消息 */}
                  <div className={styles.inputSection}>
                    <div className={styles.sectionLabel}>
                      <User size={14} /> 用户消息
                    </div>
                    <div className={styles.userMessage}>
                      {currentTurn.inputMessage || '(无输入)'}
                    </div>
                  </div>

                  {/* 聊天历史 */}
                  {historyTurns.length > 0 && (
                    <div className={styles.historySection}>
                      <div
                        className={styles.sectionLabel}
                        onClick={() => setShowHistory(!showHistory)}
                        style={{ cursor: 'pointer' }}
                      >
                        <History size={14} />
                        历史上下文 ({historyTurns.length})
                        <span className={styles.toggleIcon}>
                          <ChevronDown
                            size={14}
                            className={!showHistory ? styles.rotated : ''}
                          />
                        </span>
                      </div>
                      {showHistory && (
                        <div className={styles.chatHistory}>
                          {historyTurns.map((turn, idx) => (
                            <HistoryMessage
                              key={turn.id}
                              turn={turn}
                              onClick={() => onTurnChange(idx)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 右侧：回复对比区域 */}
                <div className={styles.replyPanel}>
                  {/* 工具调用（如果有） */}
                  {toolCalls.length > 0 && (
                    <div className={styles.toolCallsSection}>
                      <div
                        className={styles.toolCallsToggle}
                        onClick={() => setShowToolCalls(!showToolCalls)}
                      >
                        <Wrench size={12} />
                        <span>工具调用 ({toolCalls.length})</span>
                        <ChevronDown
                          size={12}
                          className={!showToolCalls ? styles.rotatedIcon : ''}
                        />
                      </div>
                      {showToolCalls && (
                        <div className={styles.toolCallsList}>
                          {toolCalls.map((tool, idx) => (
                            <ToolCallItem key={idx} tool={tool} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 期望回复 */}
                  <div className={styles.replySection}>
                    <div className={styles.sectionLabel}>
                      <MessageCircle size={14} /> 真人回复（期望）
                    </div>
                    <div className={styles.expectedReply}>
                      {currentTurn.expectedOutput || '(无期望回复)'}
                    </div>
                  </div>

                  {/* 实际回复 */}
                  <div className={styles.replySection}>
                    <div className={styles.sectionLabel}>
                      <Bot size={14} /> Agent 回复（实际）
                    </div>
                    <div className={styles.actualReply}>
                      {currentTurn.actualOutput || '(无实际回复)'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* 底部导航 */}
        <div className={styles.modalFooter}>
          <div className={styles.navigation}>
            <button
              className={styles.navBtn}
              onClick={() => onTurnChange(currentTurnIndex - 1)}
              disabled={!hasPrev || loading}
            >
              <ChevronLeft size={16} />
            </button>
            <span className={styles.turnIndicator}>
              第 {currentTurn?.turnNumber || 1} 轮 / 共 {conversation.totalTurns} 轮
            </span>
            <button
              className={styles.navBtn}
              onClick={() => onTurnChange(currentTurnIndex + 1)}
              disabled={!hasNext || loading}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ConversationDetailModal;
