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
} from 'lucide-react';
import { formatJson, formatToolResult } from '@/utils/format';
import styles from './index.module.scss';

// ==================== 思考过程组件（基于 AI reasoning） ====================

function ReasoningBlock({ text, isThinking }: { text: string; isThinking: boolean }) {
  const [expanded, setExpanded] = useState(isThinking);

  return (
    <div className={`${styles.reasoningCard} ${isThinking ? styles.reasoningActive : ''}`}>
      <div className={styles.reasoningHeader} onClick={() => setExpanded(!expanded)}>
        <div className={styles.reasoningLabel}>
          {isThinking ? (
            <Loader2 size={12} className={styles.toolSpinnerIcon} />
          ) : (
            <Brain size={12} />
          )}
          <span>{isThinking ? '思考中' : '思考过程'}</span>
        </div>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      {expanded && (
        <div className={styles.reasoningBody}>
          <Markdown>{text}</Markdown>
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

      segments.push({ kind: 'tool', tool });
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

  const hasStreamingText = segments.some(
    (s) => s.kind === 'text' && s.texts.join('').trim().length > 0,
  );

  // 提取 reasoning 文本（AI 扩展思考）— 流式和完成后都展示
  const reasoningText = parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => (p as unknown as { text: string }).text || '')
    .join('');

  return (
    <div className={styles.messagePartsContainer}>
      {reasoningText && (
        <ReasoningBlock text={reasoningText} isThinking={!!isStreaming} />
      )}
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
