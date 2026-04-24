import { useEffect, useState, memo } from 'react';
import type { UIMessage } from 'ai';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  MessageCircle,
  User,
  Clock,
  Activity,
  Calendar,
} from 'lucide-react';
import { TestExecution } from '@/api/services/agent-test.service';
import MessagePartsAdapter from '@/view/agent-test/list/components/MessagePartsAdapter';
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
  text?: string;
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

type UiPart = UIMessage['parts'][number];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildTextPart(text: string): UiPart {
  return { type: 'text', text } as UiPart;
}

function buildReasoningPart(text: string): UiPart {
  return { type: 'reasoning', text } as UiPart;
}

function getToolCallName(tool: unknown, fallbackIndex: number): string {
  const record = asRecord(tool);
  return (
    asNonEmptyString(record?.toolName) ||
    asNonEmptyString(record?.tool) ||
    asNonEmptyString(record?.name) ||
    `tool-${fallbackIndex + 1}`
  );
}

function buildToolPart(tool: unknown, index: number): UiPart {
  const record = asRecord(tool) || {};
  const toolName = getToolCallName(record, index);
  const errorText = asNonEmptyString(record.errorText) || asNonEmptyString(record.error);
  const output = record.output ?? record.result ?? (errorText ? { error: errorText } : undefined);
  const explicitState = asNonEmptyString(record.state);
  const state =
    errorText ||
    explicitState === 'error' ||
    explicitState === 'output-error' ||
    explicitState === 'input-error' ||
    explicitState === 'output-denied'
      ? 'output-error'
      : output !== undefined || explicitState === 'output-available'
        ? 'output-available'
        : 'input-available';

  return {
    type: `tool-${toolName}`,
    toolName,
    toolCallId: asNonEmptyString(record.toolCallId) || `${toolName}-${index}`,
    input: record.input ?? record.args ?? record.arguments,
    output,
    state,
    errorText,
  } as UiPart;
}

function normalizeAgentPart(part: unknown, index: number): UiPart | null {
  const record = asRecord(part);
  const partType = asNonEmptyString(record?.type);
  if (!record || !partType) return null;

  if (partType === 'text') {
    const text = asNonEmptyString(record.text);
    return text ? buildTextPart(text) : null;
  }

  if (partType === 'reasoning') {
    const text = asNonEmptyString(record.text);
    return text ? buildReasoningPart(text) : null;
  }

  if (partType === 'dynamic-tool' || partType.startsWith('tool-')) {
    return buildToolPart(
      {
        ...record,
        toolName: record.toolName || partType.replace(/^tool-/, ''),
      },
      index,
    );
  }

  if (partType === 'tool-call' || partType === 'tool-result' || partType === 'tool-error') {
    return buildToolPart(record, index);
  }

  return null;
}

function collectOrderedAgentParts(agentResponse: unknown): UiPart[] {
  const response = asRecord(agentResponse);
  if (!response) return [];

  const parts: UiPart[] = [];
  const pushParts = (value: unknown) => {
    if (!Array.isArray(value)) return;
    value.forEach((part, index) => {
      const normalized = normalizeAgentPart(part, parts.length + index);
      if (normalized) parts.push(normalized);
    });
  };

  pushParts(response.parts);

  if (Array.isArray(response.messages)) {
    response.messages.forEach((message) => {
      const record = asRecord(message);
      if (!record || (record.role && record.role !== 'assistant')) return;
      pushParts(record.parts);
    });
  }

  return parts;
}

function hasPartType(parts: UiPart[], type: 'text' | 'reasoning') {
  return parts.some((part) => part.type === type);
}

function hasToolPart(parts: UiPart[]) {
  return parts.some((part) => typeof part.type === 'string' && part.type.startsWith('tool-'));
}

function hasEquivalentTextPart(parts: UiPart[], text: string) {
  const normalizedText = text.trim();
  if (!normalizedText) return true;

  return parts.some((part) => {
    if (part.type !== 'text') return false;
    const partText = (part as { text?: string }).text?.trim();
    return partText === normalizedText;
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

function buildSyntheticAgentParts(
  agentResponse: unknown,
  toolCalls: ToolCall[],
  actualOutput: string,
): UiPart[] {
  const parts: UiPart[] = [];
  const reasoningBlocks = extractReasoningBlocks(agentResponse);
  let nextToolIndex = 0;

  reasoningBlocks.forEach((reasoning) => {
    parts.push(buildReasoningPart(reasoning));
    if (nextToolIndex < toolCalls.length) {
      parts.push(buildToolPart(toolCalls[nextToolIndex], nextToolIndex));
      nextToolIndex += 1;
    }
  });

  while (nextToolIndex < toolCalls.length) {
    parts.push(buildToolPart(toolCalls[nextToolIndex], nextToolIndex));
    nextToolIndex += 1;
  }

  if (actualOutput.trim()) {
    parts.push(buildTextPart(actualOutput.trim()));
  }

  return parts;
}

function buildAgentRenderableMessage(
  agentResponse: unknown,
  toolCalls: ToolCall[],
  actualOutput: string,
  executionId: string,
): UIMessage | undefined {
  const orderedParts = collectOrderedAgentParts(agentResponse);
  const directToolParts = toolCalls.map((tool, index) => buildToolPart(tool, index));
  const replyText = actualOutput.trim();

  if (orderedParts.length > 0) {
    const enrichedParts = [...orderedParts];

    if (directToolParts.length > 0 && !hasToolPart(enrichedParts)) {
      const firstTextIndex = enrichedParts.findIndex((part) => part.type === 'text');
      if (firstTextIndex >= 0) {
        enrichedParts.splice(firstTextIndex, 0, ...directToolParts);
      } else {
        enrichedParts.push(...directToolParts);
      }
    }

    if (replyText && !hasEquivalentTextPart(enrichedParts, replyText)) {
      enrichedParts.push(buildTextPart(replyText));
    }

    return {
      id: `test-suite-agent-${executionId}`,
      role: 'assistant',
      parts: enrichedParts,
    } as UIMessage;
  }

  const syntheticParts = buildSyntheticAgentParts(agentResponse, toolCalls, replyText);
  if (syntheticParts.length === 0) return undefined;

  if (!hasPartType(syntheticParts, 'text') && replyText) {
    syntheticParts.push(buildTextPart(replyText));
  }

  return {
    id: `test-suite-agent-${executionId}`,
    role: 'assistant',
    parts: syntheticParts,
  } as UIMessage;
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
  const actualOutput = execution.actual_output || '';
  const agentMessage = buildAgentRenderableMessage(
    execution.agent_response,
    toolCalls,
    actualOutput,
    execution.id,
  );

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

            <div className={styles.agentResponseCard}>
              <div className={styles.agentResponseHeader}>
                <span className={styles.agentRoleTag}>AGENT</span>
                {toolCalls.length > 0 && (
                  <span className={styles.agentBubbleMeta}>{toolCalls.length} 个工具调用</span>
                )}
              </div>
              <div className={`${styles.agentResponseBody} ${styles.agentRenderer}`}>
                {agentMessage ? (
                  <MessagePartsAdapter
                    message={agentMessage}
                    expandToolsByDefault={false}
                    expandReasoningByDefault={false}
                    renderTextAsMarkdown={false}
                    textFirst
                  />
                ) : (
                  <div className={styles.emptyAgentResponse}>(无回复)</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ExecutionDetailViewer;
