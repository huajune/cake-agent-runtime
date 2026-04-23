import { useState, memo } from 'react';
import {
  Zap,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ArrowLeft,
  AlertTriangle,
  MessageCircle,
  User,
  Clock,
  Activity,
} from 'lucide-react';
import { TestExecution } from '@/api/services/agent-test.service';
import { formatJson, formatToolResult } from '@/utils/format';
import type { ToolCall, TokenUsage } from '../../types';
import styles from './index.module.scss';

/**
 * 聊天历史消息类型
 */
interface HistoryMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface AgentRequestSummary {
  sessionId?: string;
  userId?: string;
  scenario?: string;
  strategySource?: string;
  modelId?: string;
}

function formatReviewerLabel(reviewer?: string | null): string | null {
  if (!reviewer) return null;
  if (reviewer === 'dashboard-user') return '人工';
  if (reviewer.toLowerCase().includes('codex')) return 'Codex';
  if (reviewer.toLowerCase().includes('claude')) return 'Claude';
  return reviewer;
}

function resolveReviewerSourceLabel(
  reviewerSource?: TestExecution['reviewer_source'],
  reviewer?: string | null,
): string | null {
  switch (reviewerSource) {
    case 'manual':
      return '人工';
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'system':
      return '系统';
    case 'api':
      return 'API';
    default:
      return formatReviewerLabel(reviewer);
  }
}

function formatReviewStatusLabel(
  reviewStatus: TestExecution['review_status'],
  reviewerLabel?: string | null,
): string {
  if (reviewStatus === 'pending') {
    return '待评审';
  }

  const prefix = reviewerLabel ? `${reviewerLabel}评审` : '评审';
  if (reviewStatus === 'passed') {
    return `${prefix}通过`;
  }
  if (reviewStatus === 'failed') {
    return `${prefix}失败`;
  }
  if (reviewStatus === 'skipped') {
    return `${prefix}跳过`;
  }

  return '待评审';
}

/**
 * 紧凑指标条组件
 */
interface CompactMetricsProps {
  durationMs: number;
  tokenUsage: TokenUsage;
  status: string;
}

function CompactMetrics({ durationMs, tokenUsage, status }: CompactMetricsProps) {
  const seconds = (durationMs / 1000).toFixed(1);

  return (
    <div className={styles.compactMetrics}>
      <div className={styles.metricItem}>
        <Clock size={14} />
        <span className={styles.metricValue}>{seconds}s</span>
      </div>
      <div className={styles.metricDivider} />
      <div className={styles.metricItem}>
        <Activity size={14} />
        <span className={styles.metricValue}>{tokenUsage.totalTokens || 0}</span>
        <span className={styles.metricLabel}>tokens</span>
        {(tokenUsage.inputTokens || tokenUsage.outputTokens) && (
          <span className={styles.tokenDetail}>
            ({tokenUsage.inputTokens || 0} / {tokenUsage.outputTokens || 0})
          </span>
        )}
      </div>
      <div className={styles.metricDivider} />
      <div className={`${styles.statusBadge} ${styles[status] || ''}`}>
        {status === 'success' ? (
          <>
            <CheckCircle2 size={12} /> 成功
          </>
        ) : status === 'failure' ? (
          <>
            <AlertTriangle size={12} /> 失败
          </>
        ) : (
          '等待中'
        )}
      </div>
    </div>
  );
}

/**
 * 工具调用组件
 */
interface ToolCallItemProps {
  tool: ToolCall;
  defaultExpanded?: boolean;
}

const ToolCallItem = memo(function ToolCallItem({ tool, defaultExpanded = false }: ToolCallItemProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const toolName = tool.toolName || tool.name || tool.tool || '未知工具';
  const hasContent = tool.input !== undefined || tool.output !== undefined;

  return (
    <div className={styles.toolCallItem}>
      <div
        className={`${styles.toolHeader} ${hasContent ? styles.clickable : ''}`}
        onClick={() => hasContent && setIsExpanded(!isExpanded)}
      >
        <div className={styles.toolName}>
          <Zap size={11} />
          {toolName}
        </div>
        {hasContent && (
          <span className={styles.expandIcon}>
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </div>
      {isExpanded && (
        <div className={styles.toolBody}>
          {tool.input !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>
                <ArrowRight size={10} /> 输入
              </div>
              <pre className={styles.toolDetail}>{formatJson(tool.input)}</pre>
            </div>
          )}
          {tool.output !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>
                <ArrowLeft size={10} /> 输出
              </div>
              <pre className={styles.toolDetail}>
                {formatToolResult(tool.output).substring(0, 800)}
                {formatToolResult(tool.output).length > 800 && '...'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * 聊天历史组件 - 简洁版
 */
interface ChatHistoryProps {
  history: HistoryMessage[];
}

const ChatHistory = memo(function ChatHistory({ history }: ChatHistoryProps) {
  if (!history || history.length === 0) return null;

  return (
    <div className={styles.chatHistory}>
      {history.map((msg, idx) => (
        <div
          key={idx}
          className={`${styles.historyMessage} ${msg.role === 'user' ? styles.user : styles.assistant}`}
        >
          <div className={styles.messageIcon}>
            {msg.role === 'user' ? <User size={12} /> : <Bot size={12} />}
          </div>
          <div className={styles.messageContent}>{msg.content}</div>
        </div>
      ))}
    </div>
  );
});

/**
 * 执行详情查看器 - 重新设计版
 * 左右分栏布局：左侧输入/历史，右侧回复
 */
interface ExecutionDetailViewerProps {
  execution: TestExecution;
  showHistory?: boolean;
}

export function ExecutionDetailViewer({ execution, showHistory = true }: ExecutionDetailViewerProps) {
  const [showToolCalls, setShowToolCalls] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(true);

  const testInput =
    execution.test_input && typeof execution.test_input === 'object' ? execution.test_input : null;
  const agentRequest =
    execution.agent_request && typeof execution.agent_request === 'object'
      ? (execution.agent_request as AgentRequestSummary)
      : null;
  const toolCalls: ToolCall[] = Array.isArray(execution.tool_calls) ? execution.tool_calls : [];
  const history = Array.isArray(testInput?.history) ? (testInput.history as HistoryMessage[]) : [];
  const inputMessage =
    execution.input_message ||
    (testInput && typeof testInput.message === 'string' ? testInput.message : '') ||
    '';
  const expectedOutput = execution.expected_output || '';
  const reviewerLabel = resolveReviewerSourceLabel(
    execution.reviewer_source,
    execution.reviewed_by,
  );
  const reviewStatusLabel = formatReviewStatusLabel(execution.review_status, reviewerLabel);

  // 指标数据
  const durationMs = execution.duration_ms || 0;
  const tokenUsage: TokenUsage =
    execution.token_usage && typeof execution.token_usage === 'object'
      ? execution.token_usage
      : {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        };

  return (
    <div className={styles.detailViewer}>
      {/* 顶部紧凑指标条 */}
      <CompactMetrics
        durationMs={durationMs}
        tokenUsage={tokenUsage}
        status={execution.execution_status}
      />

      {/* 错误信息 */}
      {execution.error_message && (
        <div className={styles.errorBox}>
          <AlertTriangle size={14} />
          <span>{execution.error_message}</span>
        </div>
      )}

      {/* 主内容区：左右分栏 */}
      <div className={styles.mainContent}>
        {/* 左侧：输入区域 */}
        <div className={styles.inputPanel}>
          {/* 用户输入消息 */}
          <div className={styles.inputSection}>
            <div className={styles.sectionLabel}>
              <User size={14} /> 用户消息
            </div>
            <div className={styles.userMessage}>{inputMessage || '(无输入)'}</div>
          </div>

          {expectedOutput && (
            <div className={styles.inputSection}>
              <div className={styles.sectionLabel}>
                <MessageCircle size={14} /> 预期输出 / 核心检查点
              </div>
              <div className={styles.expectationBox}>{expectedOutput}</div>
            </div>
          )}

          {/* 聊天历史 */}
          {showHistory && history.length > 0 && (
            <div className={styles.historySection}>
              <div
                className={styles.sectionLabel}
                onClick={() => setShowHistoryPanel(!showHistoryPanel)}
                style={{ cursor: 'pointer' }}
              >
                <MessageCircle size={14} />
                聊天上下文 ({history.length})
                <span className={styles.toggleIcon}>
                  {showHistoryPanel ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              </div>
              {showHistoryPanel && <ChatHistory history={history} />}
            </div>
          )}
        </div>

        {/* 右侧：AI 回复区域 */}
        <div className={styles.replyPanel}>
          <div className={styles.reviewInfo}>
            <div className={styles.reviewHeader}>
              <span className={styles.sectionLabel}>
                <CheckCircle2 size={14} /> 评审信息
              </span>
              <span className={styles.reviewStatus}>{reviewStatusLabel}</span>
            </div>
            <div className={styles.reviewMeta}>
              {execution.failure_reason && (
                <span className={styles.reviewPill}>失败原因: {execution.failure_reason}</span>
              )}
              {reviewerLabel && <span className={styles.reviewPill}>评审来源: {reviewerLabel}</span>}
              {execution.reviewed_at && (
                <span className={styles.reviewPill}>
                  评审时间: {new Date(execution.reviewed_at).toLocaleString('zh-CN')}
                </span>
              )}
              {agentRequest?.strategySource && (
                <span className={styles.reviewPill}>策略源: {agentRequest.strategySource}</span>
              )}
              {agentRequest?.scenario && (
                <span className={styles.reviewPill}>场景: {agentRequest.scenario}</span>
              )}
              {agentRequest?.modelId && (
                <span className={styles.reviewPill}>模型: {agentRequest.modelId}</span>
              )}
            </div>
            {execution.review_comment && (
              <div className={styles.reviewSummary}>{execution.review_comment}</div>
            )}
          </div>

          <div className={styles.sectionLabel}>
            <Bot size={14} /> AI 回复
          </div>

          {/* 工具调用（如果有） */}
          {toolCalls.length > 0 && (
            <div className={styles.toolCallsSection}>
              <div
                className={styles.toolCallsToggle}
                onClick={() => setShowToolCalls(!showToolCalls)}
              >
                <Zap size={12} />
                <span>工具调用 ({toolCalls.length})</span>
                {showToolCalls ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </div>
              {showToolCalls && (
                <div className={styles.toolCallsList}>
                  {toolCalls.map((call, idx) => (
                    <ToolCallItem key={idx} tool={call} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 回复内容 */}
          <div className={styles.replyContent}>{execution.actual_output || '(无回复)'}</div>
        </div>
      </div>
    </div>
  );
}

export default ExecutionDetailViewer;
