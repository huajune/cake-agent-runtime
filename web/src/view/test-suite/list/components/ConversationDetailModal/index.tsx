import { useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  User,
  Bot,
  Wrench,
  Headphones,
  MessageSquare,
  CheckCircle2,
} from 'lucide-react';
import type {
  ConversationSnapshot,
  ConversationTurnExecution,
  ToolCall,
  ParsedMessage,
} from '../../types';
import {
  formatReviewStatusLabel,
  resolveReviewerSourceLabel,
} from '../../utils/reviewLabel';
import { CompactMetrics } from './CompactMetrics';
import { ToolCallItem } from './ToolCallItem';
import { LoadingSkeleton } from './LoadingSkeleton';
import styles from './index.module.scss';

interface ConversationDetailModalProps {
  conversation: ConversationSnapshot;
  turns: ConversationTurnExecution[];
  currentTurnIndex: number;
  loading: boolean;
  onClose: () => void;
  onTurnChange: (index: number) => void;
}

const DYNAMIC_FACT_TOOL_NAMES = new Set([
  'duliday_job_list',
  'geocode',
  'duliday_interview_precheck',
  'duliday_interview_booking',
  'send_store_location',
  'invite_to_group',
]);

function getToolName(tool: ToolCall): string | null {
  const name = tool.toolName || tool.name || tool.tool;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function hasDynamicFactToolCall(toolCalls: ToolCall[]): boolean {
  return toolCalls.some((tool) => {
    const name = getToolName(tool);
    return Boolean(name && DYNAMIC_FACT_TOOL_NAMES.has(name));
  });
}

/**
 * 真人对话历史消息组件
 */
function RealHistoryMessage({ message }: { message: ParsedMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={styles.historyMessage}>
      <div className={isUser ? styles.historyUser : styles.historyAssistant}>
        {isUser ? <User size={12} /> : <Headphones size={12} />}
        <span>{message.content}</span>
      </div>
    </div>
  );
}

/**
 * 回归验证详情弹窗
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

  // 获取当前轮次的真人对话历史（候选人 + 招募经理）
  const realHistory = Array.isArray(currentTurn?.history) ? currentTurn.history : [];

  // 获取工具调用（将 unknown[] 转换为 ToolCall[]）
  const toolCalls = (
    Array.isArray(currentTurn?.toolCalls) ? currentTurn.toolCalls : []
  ) as ToolCall[];
  const isDynamicToolTurn = hasDynamicFactToolCall(toolCalls);
  const reviewerLabel = resolveReviewerSourceLabel(
    currentTurn?.reviewerSource,
    currentTurn?.reviewedBy,
  );
  const reviewStatusLabel = formatReviewStatusLabel(currentTurn?.reviewStatus, reviewerLabel);

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
              总轮数: {conversation.totalTurns} · 平均评分:{' '}
              {conversation.avgSimilarityScore !== null
                ? `${conversation.avgSimilarityScore}分`
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
                evaluationReason={currentTurn.evaluationReason}
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

                  {/* 真人对话历史（候选人 + 招募经理） */}
                  {realHistory.length > 0 && (
                    <div className={styles.historySection}>
                      <div
                        className={styles.sectionLabel}
                        onClick={() => setShowHistory(!showHistory)}
                        style={{ cursor: 'pointer' }}
                      >
                        <MessageSquare size={14} />
                        历史上下文 ({realHistory.length})
                        <span className={styles.toggleIcon}>
                          <ChevronDown
                            size={14}
                            className={!showHistory ? styles.rotated : ''}
                          />
                        </span>
                      </div>
                      {showHistory && (
                        <div className={styles.chatHistory}>
                          {realHistory.map((msg, idx) => (
                            <RealHistoryMessage key={idx} message={msg} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 右侧：回复对比区域 */}
                <div className={styles.replyPanel}>
                  <div className={styles.reviewInfo}>
                    <div className={styles.reviewHeader}>
                      <span className={styles.sectionLabel}>
                        <CheckCircle2 size={14} /> 评审信息
                      </span>
                      <span className={styles.reviewStatus}>{reviewStatusLabel}</span>
                    </div>
                    <div className={styles.reviewMeta}>
                      {currentTurn.failureReason && (
                        <span className={styles.reviewPill}>
                          失败原因: {currentTurn.failureReason}
                        </span>
                      )}
                      {reviewerLabel && (
                        <span className={styles.reviewPill}>
                          评审来源: {reviewerLabel}
                        </span>
                      )}
                      {currentTurn.reviewedAt && (
                        <span className={styles.reviewPill}>
                          评审时间: {new Date(currentTurn.reviewedAt).toLocaleString('zh-CN')}
                        </span>
                      )}
                      {conversation.conversationId && (
                        <span className={styles.reviewPill}>
                          chatId: {conversation.conversationId}
                        </span>
                      )}
                    </div>
                    {currentTurn.reviewComment && (
                      <div className={styles.reviewSummary}>{currentTurn.reviewComment}</div>
                    )}
                  </div>

                  {/* 期望回复 */}
                  <div className={styles.replySection}>
                    <div className={styles.sectionLabel}>
                      <Headphones size={14} />{' '}
                      {isDynamicToolTurn ? '真人回复（历史参考）' : '真人回复（期望）'}
                    </div>
                    {isDynamicToolTurn && (
                      <div className={styles.referenceHint}>
                        本轮调用了动态工具，评审以本轮工具结果为事实锚点；这条历史回复只作话术参考。
                      </div>
                    )}
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
                      {(typeof currentTurn.actualOutput === 'string'
                        ? currentTurn.actualOutput.replace(/\n\n+/g, ' ')
                        : '') || '(无实际回复)'}
                    </div>
                  </div>

                  {/* 工具调用（如果有） - 移到 Agent 回复下面 */}
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
