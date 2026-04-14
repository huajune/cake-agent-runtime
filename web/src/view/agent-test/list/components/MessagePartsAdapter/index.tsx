import { memo, useState } from 'react';
import type { UIMessage } from 'ai';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
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

function normalizeMarkdownText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    // Collapse 3+ newlines → 1 blank line
    .replace(/\n{3,}/g, '\n\n')
    // Remove blank lines BEFORE any list item (numbered or bulleted)
    .replace(/\n\n+(?=\d+\.\s)/g, '\n')
    .replace(/\n\n+(?=[-*]\s)/g, '\n')
    // Remove blank lines after colon-ending lines (e.g. "我需要：\n\n1.")
    .replace(/([：:]\s*)\n\n+/g, '$1\n')
    // Fix orphaned list markers: "1.\n\ntext" → "1. text"
    .replace(/(^|\n)(\d+\.)\s*\n+(?=\S)/g, '$1$2 ')
    .replace(/(^|\n)([-*])\s*\n+(?=\S)/g, '$1$2 ')
    .trim();
}

function ReasoningBlock({
  text,
  isThinking,
  defaultExpanded = true,
}: {
  text: string;
  isThinking: boolean;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const normalizedText = normalizeMarkdownText(text);

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
          {isThinking ? (
            <pre className={styles.reasoningPlainText}>{normalizedText}</pre>
          ) : (
            <Markdown remarkPlugins={[remarkBreaks]}>{normalizedText}</Markdown>
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
              <>
                <Loader2 size={12} className={styles.toolSpinnerIcon} /> 调用中
              </>
            ) : (
              <>
                <CheckCircle2 size={12} /> 完成
              </>
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
                  <Markdown remarkPlugins={[remarkBreaks]}>
                    {normalizeMarkdownText(extractMarkdown(result)!)}
                  </Markdown>
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
  | { kind: 'tool'; tool: ExtractedToolCall }
  | { kind: 'reasoning'; text: string };

function buildSegments(parts: UIMessage['parts']): Segment[] {
  const segments: Segment[] = [];

  for (const part of parts) {
    if (part.type === 'reasoning') {
      const text = (part as unknown as { text: string }).text || '';
      if (text) {
        // 合并相邻的 reasoning 段
        const last = segments[segments.length - 1];
        if (last && last.kind === 'reasoning') {
          last.text += text;
        } else {
          segments.push({ kind: 'reasoning', text });
        }
      }
    } else if (part.type === 'text') {
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
        toolCallId: toolPart.toolCallId || `${extractedToolName}-${segments.length}`,
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
  expandToolsByDefault?: boolean;
  expandReasoningByDefault?: boolean;
  renderTextAsMarkdown?: boolean;
}

function MessagePartsAdapterComponent({
  message,
  isStreaming,
  expandToolsByDefault = false,
  expandReasoningByDefault = true,
  renderTextAsMarkdown = false,
}: MessagePartsAdapterProps) {
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

  return (
    <div className={styles.messagePartsContainer}>
      {segments.map((seg, idx) => {
        if (seg.kind === 'reasoning') {
          // 最后一个 reasoning 段在流式中显示为"思考中"，其余为已完成
          const isLastReasoning =
            !!isStreaming && segments.slice(idx + 1).every((s) => s.kind !== 'reasoning');
          return (
            <ReasoningBlock
              key={`reasoning-${idx}`}
              text={seg.text}
              isThinking={isLastReasoning}
              defaultExpanded={expandReasoningByDefault}
            />
          );
        }

        if (seg.kind === 'text') {
          const text = seg.texts.join('');
          if (!text && !isStreaming) return null;
          const normalizedText = renderTextAsMarkdown ? normalizeMarkdownText(text) : text;
          return (
            <div key={`text-${idx}`} className={styles.replyContent}>
              {normalizedText ? (
                renderTextAsMarkdown ? (
                  <div className={styles.replyMarkdown}>
                    <Markdown remarkPlugins={[remarkBreaks]}>{normalizedText}</Markdown>
                  </div>
                ) : (
                  normalizedText
                )
              ) : (
                <span className={styles.streamingPlaceholder}>等待响应...</span>
              )}
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
            defaultExpanded={expandToolsByDefault}
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

export const MessagePartsAdapter = memo(MessagePartsAdapterComponent);

export default MessagePartsAdapter;
