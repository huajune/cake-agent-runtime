import { memo, useState } from 'react';
import type { UIMessage } from 'ai';
import Markdown from 'react-markdown';
import {
  Zap,
  CheckCircle2,
  Loader2,
  ArrowRight,
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  Brain,
  Target,
} from 'lucide-react';
import { formatJson, formatToolResult } from '@/utils/format';
import styles from './index.module.scss';

// ==================== 常量 ====================
const THINKING_TOOL = 'wework_plan_turn';

const STAGE_LABELS: Record<string, string> = {
  trust_building: '建立信任',
  qualify_candidate: '资格确认',
  job_consultation: '岗位咨询',
  interview_scheduling: '约面安排',
  onboard_followup: '入职跟进',
};

// ==================== 思考过程组件 ====================
interface PlanTurnOutput {
  stage?: string;
  reasoning?: string;
  confidence?: number;
  needs?: string[];
  riskFlags?: string[];
  stageGoal?: {
    label?: string;
    primaryGoal?: string;
    ctaStrategy?: string[];
    disallowedActions?: string[];
  };
}

function ThinkingBlock({ output, isCalling, reasoningText }: { output: PlanTurnOutput; isCalling: boolean; reasoningText?: string }) {
  const [showDetail, setShowDetail] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);

  if (isCalling) {
    return (
      <div className={styles.thinkingBlock}>
        <div className={styles.thinkingHeader}>
          <Brain size={14} />
          <span>思考中</span>
          <Loader2 size={14} className={styles.toolSpinnerIcon} />
        </div>
        <div className={styles.thinkingReasoning}>
          <Markdown>{reasoningText || '正在进行回合规划，识别当前对话阶段、评估置信度、分析用户需求...'}</Markdown>
        </div>
      </div>
    );
  }

  const stage = output.stage || 'unknown';
  const stageLabel = STAGE_LABELS[stage] || stage;
  const confidence = output.confidence ?? 0;
  const reasoning = output.reasoning || '';
  const needs = output.needs || [];
  const riskFlags = output.riskFlags || [];
  const stageGoal = output.stageGoal;
  const hasDetail = stageGoal || needs.length > 0 || riskFlags.length > 0;

  return (
    <div className={styles.thinkingBlock}>
      <div className={styles.thinkingHeader}>
        <Brain size={14} />
        <span>思考过程</span>
        <span className={styles.stageBadge}>{stageLabel}</span>
        <span className={styles.confidenceBadge}>
          置信度 {(confidence * 100).toFixed(0)}%
        </span>
      </div>

      {reasoningText && (
        <div
          className={styles.thinkingDetailToggle}
          onClick={() => setShowReasoning(!showReasoning)}
        >
          {showReasoning ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Brain size={12} />
          工作思路
        </div>
      )}

      {showReasoning && reasoningText && (
        <div className={styles.thinkingDetail}>
          <div className={styles.thinkingReasoning}><Markdown>{reasoningText}</Markdown></div>
        </div>
      )}

      {reasoning && (
        <div className={styles.thinkingReasoning}><Markdown>{reasoning}</Markdown></div>
      )}

      {needs.length > 0 && needs[0] !== 'none' && (
        <div className={styles.thinkingNeeds}>
          <span className={styles.needsLabel}>NeedsInfo:</span>
          {needs.map((n) => (
            <span key={n} className={styles.needTag}>{n}</span>
          ))}
        </div>
      )}

      {riskFlags.length > 0 && (
        <div className={styles.thinkingRisks}>
          <span className={styles.needsLabel}>风险标记:</span>
          {riskFlags.map((r) => (
            <span key={r} className={styles.riskTag}>{r}</span>
          ))}
        </div>
      )}

      {hasDetail && (
        <div
          className={styles.thinkingDetailToggle}
          onClick={() => setShowDetail(!showDetail)}
        >
          {showDetail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Target size={12} />
          策略详情
        </div>
      )}

      {showDetail && stageGoal && (
        <div className={styles.thinkingDetail}>
          {stageGoal.primaryGoal && (
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>目标</span>
              <span>{stageGoal.primaryGoal}</span>
            </div>
          )}
          {stageGoal.ctaStrategy && stageGoal.ctaStrategy.length > 0 && (
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>策略</span>
              <ul className={styles.detailList}>
                {stageGoal.ctaStrategy.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </div>
          )}
          {stageGoal.disallowedActions && stageGoal.disallowedActions.length > 0 && (
            <div className={styles.detailItem}>
              <span className={styles.detailLabel}>禁止</span>
              <ul className={styles.detailList}>
                {stageGoal.disallowedActions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ==================== 工具结果 Markdown 提取 ====================
function extractMarkdown(result: unknown): string | null {
  if (typeof result === 'object' && result !== null) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.markdown === 'string') {
      return obj.markdown;
    }
  }
  return null;
}

// ==================== 通用工具调用组件 ====================
interface ToolInvocationProps {
  toolName: string;
  args: unknown;
  state: string;
  result?: unknown;
  defaultExpanded?: boolean;
}

function ToolInvocation({
  toolName,
  args,
  state,
  result,
  defaultExpanded = false,
}: ToolInvocationProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const isCompleted = state === 'result';
  const isCalling = state !== 'result';

  const hasContent =
    (args !== undefined && args !== null) ||
    (isCompleted && result !== undefined && result !== null);

  return (
    <div className={`${styles.toolCallItem} ${isCalling ? styles.toolCalling : ''}`}>
      <div
        className={`${styles.toolHeader} ${hasContent ? styles.toolHeaderClickable : ''}`}
        onClick={() => hasContent && setIsExpanded(!isExpanded)}
      >
        <div className={styles.toolName}>
          {isCalling ? <Loader2 size={12} className={styles.toolSpinnerIcon} /> : <Zap size={12} />}
          {toolName}
        </div>
        <div className={styles.toolHeaderRight}>
          <div
            className={`${styles.toolStatus} ${isCalling ? styles.statusCalling : styles.statusSuccess}`}
          >
            {isCalling ? (
              <><Loader2 size={12} className={styles.toolSpinnerIcon} /> 调用中</>
            ) : (
              <><CheckCircle2 size={12} /> 完成</>
            )}
          </div>
          {hasContent && (
            <span className={styles.toolExpandIcon}>
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className={styles.toolBody}>
          {args !== undefined && args !== null && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>
                <ArrowRight size={12} /> 输入参数
              </div>
              <pre className={styles.toolDetail}>{formatJson(args)}</pre>
            </div>
          )}
          {isCompleted && result !== undefined && result !== null && (
            <div className={styles.toolSection}>
              <div className={styles.toolSectionLabel}>
                <ArrowLeft size={12} /> 返回结果
              </div>
              {extractMarkdown(result) ? (
                <div className={styles.toolResultMarkdown}>
                  <Markdown>{extractMarkdown(result)!}</Markdown>
                </div>
              ) : (
                <pre className={styles.toolDetail}>{formatToolResult(result)}</pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ==================== Segment 构建 ====================
interface ExtractedToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  state: string;
  result?: unknown;
}

type Segment =
  | { kind: 'text'; texts: string[] }
  | { kind: 'thinking'; tool: ExtractedToolCall }
  | { kind: 'tool'; tool: ExtractedToolCall };

function buildSegments(parts: UIMessage['parts']): Segment[] {
  const segments: Segment[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      const text = (part as { type: 'text'; text: string }).text;
      const last = segments[segments.length - 1];
      if (last && last.kind === 'text') {
        last.texts.push(text);
      } else {
        segments.push({ kind: 'text', texts: [text] });
      }
    } else if (part.type.startsWith('tool-')) {
      const toolPart = part as unknown as {
        type: string;
        toolCallId?: string;
        toolName?: string;
        input?: unknown;
        state?: string;
        output?: unknown;
      };

      const extractedToolName = toolPart.toolName || part.type.replace(/^tool-/, '');
      const isCompleted =
        toolPart.state === 'output-available' ||
        toolPart.state === 'output-error' ||
        toolPart.output !== undefined;

      const tool: ExtractedToolCall = {
        toolCallId: toolPart.toolCallId || `tool-${Date.now()}-${segments.length}`,
        toolName: extractedToolName,
        args: toolPart.input,
        state: isCompleted ? 'result' : 'call',
        result: toolPart.output,
      };

      segments.push({
        kind: extractedToolName === THINKING_TOOL ? 'thinking' : 'tool',
        tool,
      });
    }
  }

  return segments;
}

// ==================== 主组件 ====================
interface MessagePartsAdapterProps {
  message: UIMessage;
  isStreaming?: boolean;
}

function MessagePartsAdapterComponent({ message, isStreaming }: MessagePartsAdapterProps) {
  const parts = message.parts;

  if (!parts || parts.length === 0) {
    return (
      <div className={styles.replyContent}>
        {isStreaming ? (
          <span className={styles.streamingLoading}>
            <span className={styles.loadingDots}>
              <span />
              <span />
              <span />
            </span>
            <span className={styles.streamingPlaceholder}>思考中</span>
          </span>
        ) : (
          <span className={styles.streamingPlaceholder}>等待响应...</span>
        )}
      </div>
    );
  }

  const segments = buildSegments(parts);

  // 判断是否已有文本内容在流式输出（用于决定底部显示光标还是 loading）
  const hasStreamingText = segments.some(
    (s) => s.kind === 'text' && s.texts.join('').trim().length > 0,
  );

  // 提取 reasoning 文本（AI 扩展思考，逐字流式到达）
  const reasoningText = parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => (p as unknown as { text: string }).text || '')
    .join('');
  const hasThinkingSegment = segments.some((s) => s.kind === 'thinking');
  const showEarlyThinking = isStreaming && reasoningText && !hasThinkingSegment;

  return (
    <div className={styles.messagePartsContainer}>
      {showEarlyThinking && <ThinkingBlock output={{}} isCalling={true} reasoningText={reasoningText} />}
      {segments.map((seg, idx) => {
        if (seg.kind === 'text') {
          const text = seg.texts.join('');
          if (!text && !isStreaming) return null;
          return (
            <div key={`text-${idx}`} className={styles.replyContent}>
              {text || <span className={styles.streamingPlaceholder}>等待响应...</span>}
            </div>
          );
        }

        if (seg.kind === 'thinking') {
          const isCalling = seg.tool.state !== 'result';
          const output = (seg.tool.result as PlanTurnOutput) || {};
          return (
            <div key={seg.tool.toolCallId} className={styles.thinkingToolGroup}>
              <ThinkingBlock output={output} isCalling={isCalling} reasoningText={reasoningText} />
              <ToolInvocation
                toolName={seg.tool.toolName}
                args={seg.tool.args}
                state={seg.tool.state}
                result={seg.tool.result}
              />
            </div>
          );
        }

        return (
          <ToolInvocation
            key={seg.tool.toolCallId}
            toolName={seg.tool.toolName}
            args={seg.tool.args}
            state={seg.tool.state}
            result={seg.tool.result}
          />
        );
      })}
      {isStreaming &&
        (hasStreamingText ? (
          <span className={styles.streamCursor}>|</span>
        ) : (
          <span className={styles.streamingWaiting}>正在生成回复</span>
        ))}
    </div>
  );
}

export const MessagePartsAdapter = memo(MessagePartsAdapterComponent, (prevProps, nextProps) => {
  if (nextProps.isStreaming) {
    return false;
  }
  return prevProps.message.id === nextProps.message.id;
});

export default MessagePartsAdapter;
