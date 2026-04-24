import { useEffect, useState, memo } from 'react';
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
  Calendar,
  Brain,
} from 'lucide-react';
import { TestExecution } from '@/api/services/agent-test.service';
import { formatJson, formatToolResult } from '@/utils/format';
import type { ToolCall, TokenUsage } from '../../types';
import { formatReviewStatusLabel, resolveReviewerSourceLabel } from '../../utils/reviewLabel';
import styles from './index.module.scss';

/**
 * 聊天历史消息类型
 */
interface HistoryMessage {
  role?: 'user' | 'assistant' | 'system' | string;
  content: string;
  speaker?: string;
  name?: string;
  sender?: string;
  senderRole?: string;
  senderType?: string;
  from?: string;
}

interface AgentRequestSummary {
  sessionId?: string;
  userId?: string;
  scenario?: string;
  strategySource?: string;
  modelId?: string;
}

interface AgentStepSummary {
  reasoning?: string;
}

/**
 * 紧凑指标条组件
 */
interface CompactMetricsProps {
  durationMs: number;
  tokenUsage: TokenUsage;
  status: string;
  executedAt?: string | null;
}

const numberFormatter = new Intl.NumberFormat('zh-CN');

function formatDuration(durationMs: number) {
  if (!durationMs) return '--';
  const seconds = durationMs / 1000;
  return seconds >= 60 ? `${(seconds / 60).toFixed(1)}min` : `${seconds.toFixed(1)}s`;
}

function getExecutionStatusLabel(status: string) {
  const labels: Record<string, string> = {
    success: '成功',
    failure: '失败',
    timeout: '超时',
    running: '执行中',
    pending: '等待中',
  };
  return labels[status] || status || '未知';
}

function formatExecutedAt(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function extractReasoningBlocks(agentResponse: unknown): string[] {
  if (!agentResponse || typeof agentResponse !== 'object') return [];

  const response = agentResponse as Record<string, unknown>;
  const blocks: string[] = [];

  const pushReasoning = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text) blocks.push(text);
  };

  pushReasoning(response.reasoning);
  pushReasoning(response.reasoningPreview);

  if (response.reply && typeof response.reply === 'object') {
    pushReasoning((response.reply as Record<string, unknown>).reasoning);
  }

  const possibleSteps = Array.isArray(response.agentSteps)
    ? response.agentSteps
    : Array.isArray(response.steps)
      ? response.steps
      : [];

  possibleSteps.forEach((step) => {
    if (!step || typeof step !== 'object') return;
    pushReasoning((step as AgentStepSummary).reasoning);
  });

  if (Array.isArray(response.messages)) {
    response.messages.forEach((message) => {
      if (!message || typeof message !== 'object') return;
      const parts = (message as Record<string, unknown>).parts;
      if (!Array.isArray(parts)) return;
      parts.forEach((part) => {
        if (!part || typeof part !== 'object') return;
        const item = part as Record<string, unknown>;
        if (item.type === 'reasoning') pushReasoning(item.text);
      });
    });
  }

  return Array.from(new Set(blocks));
}

function getReviewTone(status: string) {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'skipped') return 'skipped';
  return 'pending';
}

function CompactMetrics({ durationMs, tokenUsage, status, executedAt }: CompactMetricsProps) {
  const statusLabel = getExecutionStatusLabel(status);
  const executedAtText = formatExecutedAt(executedAt);

  return (
    <div className={styles.compactMetrics}>
      <div className={styles.metricItem}>
        <Clock size={14} />
        <span className={styles.metricText}>执行耗时</span>
        <span className={styles.metricValue}>{formatDuration(durationMs)}</span>
      </div>
      <div className={styles.metricDivider} />
      <div className={styles.metricItem}>
        <Activity size={14} />
        <span className={styles.metricText}>Tokens</span>
        <span className={styles.metricValue}>
          {numberFormatter.format(tokenUsage.totalTokens || 0)}
        </span>
        {(tokenUsage.inputTokens || tokenUsage.outputTokens) && (
          <span className={styles.tokenDetail}>
            输入 {numberFormatter.format(tokenUsage.inputTokens || 0)} / 输出{' '}
            {numberFormatter.format(tokenUsage.outputTokens || 0)}
          </span>
        )}
      </div>
      {executedAtText && (
        <>
          <div className={styles.metricDivider} />
          <div className={styles.metricItem}>
            <Calendar size={14} />
            <span className={styles.metricText}>执行时间</span>
            <span className={styles.metricValue}>{executedAtText}</span>
          </div>
        </>
      )}
      <div className={`${styles.statusBadge} ${styles[status] || ''}`}>
        {status === 'success' ? (
          <>
            <CheckCircle2 size={12} /> {statusLabel}
          </>
        ) : status === 'failure' ? (
          <>
            <AlertTriangle size={12} /> {statusLabel}
          </>
        ) : (
          statusLabel
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

const ToolCallItem = memo(function ToolCallItem({
  tool,
  defaultExpanded = false,
}: ToolCallItemProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const toolName = tool.toolName || tool.name || tool.tool || '未知工具';
  const toolInput = tool.input ?? tool.args ?? tool.arguments;
  const toolOutput = tool.output ?? tool.result;
  const hasContent = toolInput !== undefined || toolOutput !== undefined;

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
        <div className={styles.toolHeaderRight}>
          <span className={styles.toolStatus}>
            <CheckCircle2 size={12} /> 完成
          </span>
          {hasContent && (
            <span className={styles.expandIcon}>
              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className={styles.toolBody}>
          {toolInput !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>
                <ArrowRight size={10} /> 输入
              </div>
              <pre className={styles.toolDetail}>{formatJson(toolInput)}</pre>
            </div>
          )}
          {toolOutput !== undefined && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>
                <ArrowLeft size={10} /> 输出
              </div>
              <pre className={styles.toolDetail}>
                {formatToolResult(toolOutput).substring(0, 800)}
                {formatToolResult(toolOutput).length > 800 && '...'}
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

function shouldInferAlternatingRoles(history: HistoryMessage[]) {
  if (history.length < 2) return false;
  return !history.some((message) => {
    const role = typeof message.role === 'string' ? message.role.toLowerCase().trim() : '';
    return role === 'assistant' || role === 'agent' || role === 'bot';
  });
}

function getHistoryMessageRole(
  message: HistoryMessage,
  index: number,
  inferAlternatingRoles: boolean,
): 'user' | 'assistant' {
  if (inferAlternatingRoles) {
    return index % 2 === 0 ? 'user' : 'assistant';
  }

  const primaryRole = typeof message.role === 'string' ? message.role.toLowerCase().trim() : '';
  const roleHint = [
    message.role,
    message.senderRole,
    message.senderType,
    message.from,
    message.speaker,
    message.name,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (primaryRole === 'assistant' || primaryRole === 'agent' || primaryRole === 'bot') {
    return 'assistant';
  }
  if (/(assistant|agent|bot|ai|招聘|顾问|客服|经理|hr|系统)/i.test(roleHint)) {
    return 'assistant';
  }
  if (primaryRole === 'user') {
    return 'user';
  }
  if (/(user|candidate|候选|求职|客户|用户|boss)/i.test(roleHint)) {
    return 'user';
  }

  return 'user';
}

const ChatHistory = memo(function ChatHistory({ history }: ChatHistoryProps) {
  if (!history || history.length === 0) return null;
  const inferAlternatingRoles = shouldInferAlternatingRoles(history);

  return (
    <div className={styles.chatHistory}>
      {history.map((msg, idx) => {
        const role = getHistoryMessageRole(msg, idx, inferAlternatingRoles);
        return (
          <div
            key={idx}
            className={`${styles.historyMessage} ${role === 'user' ? styles.user : styles.assistant}`}
          >
            <div className={styles.messageIcon}>
              {role === 'user' ? <User size={12} /> : <Bot size={12} />}
            </div>
            <div className={styles.messageContent}>{msg.content}</div>
          </div>
        );
      })}
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

export function ExecutionDetailViewer({
  execution,
  showHistory = true,
}: ExecutionDetailViewerProps) {
  const testInput =
    execution.test_input && typeof execution.test_input === 'object' ? execution.test_input : null;
  const agentRequest =
    execution.agent_request && typeof execution.agent_request === 'object'
      ? (execution.agent_request as AgentRequestSummary)
      : null;
  const toolCalls: ToolCall[] = Array.isArray(execution.tool_calls) ? execution.tool_calls : [];
  const reasoningBlocks = extractReasoningBlocks(execution.agent_response);
  const hasReasoningTrace = reasoningBlocks.length > 0;
  const history = Array.isArray(testInput?.history) ? (testInput.history as HistoryMessage[]) : [];
  const [showHistoryPanel, setShowHistoryPanel] = useState(true);
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
  const reviewTone = getReviewTone(execution.review_status);

  // 构建评审 meta 单行文本（紧凑展示）
  const reviewMetaItems: Array<{ label: string; value: string }> = [];
  if (reviewerLabel) reviewMetaItems.push({ label: '评审来源', value: reviewerLabel });
  if (execution.reviewed_at) {
    reviewMetaItems.push({
      label: '评审时间',
      value: new Date(execution.reviewed_at).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  }
  if (agentRequest?.modelId) reviewMetaItems.push({ label: '模型', value: agentRequest.modelId });
  if (execution.category) reviewMetaItems.push({ label: '分类', value: execution.category });
  if (agentRequest?.sessionId)
    reviewMetaItems.push({ label: 'Session', value: agentRequest.sessionId });

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

  useEffect(() => {
    setShowHistoryPanel(true);
  }, [execution.id]);

  return (
    <div className={styles.detailViewer}>
      {/* 顶部紧凑指标条 */}
      <CompactMetrics
        durationMs={durationMs}
        tokenUsage={tokenUsage}
        status={execution.execution_status}
        executedAt={execution.executed_at}
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
        {/* 左侧：用户消息 + 聊天上下文 */}
        <div className={styles.inputPanel}>
          <div className={styles.inputSummary}>
            <div className={styles.inputTitle}>
              <User size={13} /> 当前消息
            </div>
            <p className={styles.userMessage}>{inputMessage || '(无输入)'}</p>
          </div>

          {expectedOutput && (
            <div className={styles.inputSection}>
              <div className={styles.sectionLabel}>
                <MessageCircle size={14} /> 预期输出 / 核心检查点
              </div>
              <div className={styles.expectationBox}>{expectedOutput}</div>
            </div>
          )}

          {showHistory && history.length > 0 && (
            <div className={styles.historySection}>
              <button
                type="button"
                className={`${styles.sectionLabel} ${styles.sectionToggle}`}
                onClick={() => setShowHistoryPanel(!showHistoryPanel)}
                aria-expanded={showHistoryPanel}
              >
                <MessageCircle size={14} />
                聊天上下文 ({history.length})
                <span className={styles.toggleIcon}>
                  {showHistoryPanel ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
              </button>
              {showHistoryPanel ? (
                <ChatHistory history={history} />
              ) : (
                <button
                  type="button"
                  className={styles.historyCollapsed}
                  onClick={() => setShowHistoryPanel(true)}
                >
                  已收起 {history.length} 条上下文，点击展开查看
                </button>
              )}
            </div>
          )}
        </div>

        {/* 右侧：评审信息 + 预期输出 + AI 回复 */}
        <div className={styles.replyPanel}>
          <div className={styles.reviewInfo}>
            <div className={styles.reviewHeader}>
              <span className={styles.sectionLabel}>
                <CheckCircle2 size={14} /> 评审信息
              </span>
              <span className={`${styles.reviewStatus} ${styles[reviewTone]}`}>
                {reviewStatusLabel}
              </span>
            </div>
            <div className={styles.reviewCard}>
              {reviewMetaItems.length > 0 && (
                <div className={styles.reviewMeta}>
                  {reviewMetaItems.map((item, idx) => (
                    <span key={`${item.label}-${idx}`} className={styles.reviewMetaItem}>
                      <span className={styles.reviewMetaLabel}>{item.label}：</span>
                      <span className={styles.reviewMetaValue} title={item.value}>
                        {item.value}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              {execution.review_comment && (
                <div className={styles.reviewSummary}>{execution.review_comment}</div>
              )}
              {execution.failure_reason && (
                <div className={styles.failureReasonRow}>
                  <AlertTriangle size={12} />
                  <span>失败原因：{execution.failure_reason}</span>
                </div>
              )}
            </div>
          </div>

          <div className={styles.replySection}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionLabel}>
                <Bot size={14} /> AI 回复
              </div>
            </div>

            {hasReasoningTrace && (
              <div className={styles.agentTrace}>
                {reasoningBlocks.map((reasoning, idx) => (
                  <details key={`reasoning-${idx}`} className={styles.traceItem}>
                    <summary className={styles.traceHeader}>
                      <span className={styles.traceName}>
                        <Brain size={12} />
                        模型推理摘要
                      </span>
                      <ChevronRight size={14} className={styles.traceChevron} />
                    </summary>
                    <pre className={styles.traceBody}>{reasoning}</pre>
                  </details>
                ))}
              </div>
            )}

            {!hasReasoningTrace && (
              <div className={styles.traceUnavailable}>
                <Brain size={14} />
                <span>
                  本次执行未记录模型推理摘要。完整隐式思考链不会展示；可结合评审信息、工具调用和回复内容判断。
                </span>
              </div>
            )}

            <div className={styles.replyContent}>{execution.actual_output || '(无回复)'}</div>

            {toolCalls.length > 0 && (
              <div className={styles.toolCallsFooter}>
                <div className={styles.toolCallsFooterTitle}>
                  <Zap size={14} />
                  <span>工具调用</span>
                  <em>{toolCalls.length} 个工具</em>
                </div>
                <div className={styles.toolCallsList}>
                  {toolCalls.map((call, idx) => (
                    <ToolCallItem key={idx} tool={call} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ExecutionDetailViewer;
