import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatDuration, formatJson } from '@/utils/format';
import type { MessageRecord, MessageRecordToolCallStatus } from '@/api/types/chat.types';
import { describeToolExecution } from '@/view/message-processing/tool-execution';
import { getToolCalls, type ToolCallInfo } from '../utils';
import styles from './index.module.scss';

interface ToolExecutionPanelProps {
  toolCalls: ToolCallInfo[];
  message: MessageRecord;
}

const STATUS_LABELS: Record<MessageRecordToolCallStatus, string> = {
  ok: 'OK',
  empty: 'EMPTY',
  narrow: 'NARROW',
  unknown: 'UNKNOWN',
  error: 'ERROR',
};

function getStatusClass(status: MessageRecordToolCallStatus): string {
  if (status === 'empty' || status === 'narrow') return styles.statusWarning;
  if (status === 'error') return styles.statusError;
  if (status === 'ok') return styles.statusSuccess;
  return styles.statusUnknown;
}

function ToolExecutionItem({ toolCall }: { toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(false);
  const { outcome, judgments } = useMemo(
    () => describeToolExecution(toolCall.name, toolCall.output),
    [toolCall.name, toolCall.output],
  );

  return (
    <li className={styles.toolItem}>
      <button
        type="button"
        className={styles.toolHeader}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.toolIdentity}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className={styles.toolName} title={outcome}>
            {toolCall.name}
            {outcome && ` · ${outcome}`}
          </span>
        </span>
        <span className={styles.toolMeta}>
          {toolCall.durationMs !== undefined ? (
            <span title={`${toolCall.durationMs} ms`}>{formatDuration(toolCall.durationMs)}</span>
          ) : null}
          {toolCall.resultCount !== undefined ? <span>{toolCall.resultCount} 条</span> : null}
          {toolCall.errorType ? <span>{toolCall.errorType}</span> : null}
          {toolCall.apiCode !== undefined ? <span>apiCode={toolCall.apiCode}</span> : null}
          <span className={`${styles.statusBadge} ${getStatusClass(toolCall.status)}`}>
            {STATUS_LABELS[toolCall.status] ?? toolCall.status}
          </span>
        </span>
      </button>
      {expanded ? (
        <>
          <div className={styles.toolDetails}>
            <div>
              <div className={styles.detailLabel}>本次判断</div>
              {judgments.length > 0 ? (
                <ul className={styles.toolList}>
                  {judgments.map((judgment, index) => (
                    <li key={index}>{judgment}</li>
                  ))}
                </ul>
              ) : (
                <div>{toolCall.output == null ? '未记录工具返回值' : '仅记录最终结果'}</div>
              )}
            </div>
          </div>
          {(toolCall.input !== undefined || toolCall.output !== undefined) && (
            <div className={styles.toolDetails}>
              {toolCall.input !== undefined ? (
                <div>
                  <div className={styles.detailLabel}>输入参数</div>
                  <pre>{formatJson(toolCall.input)}</pre>
                </div>
              ) : null}
              {toolCall.output !== undefined ? (
                <div>
                  <div className={styles.detailLabel}>返回结果</div>
                  <pre>
                    {typeof toolCall.output === 'string'
                      ? toolCall.output
                      : formatJson(toolCall.output)}
                  </pre>
                </div>
              ) : null}
            </div>
          )}
        </>
      ) : null}
    </li>
  );
}

export default function ToolExecutionPanel({ toolCalls, message }: ToolExecutionPanelProps) {
  // 旧流水可能只保留逐步调用。整组使用同一来源，同名调用各自展示自己的回执。
  const calls = useMemo(() => {
    if (toolCalls.length) return toolCalls;
    if (Array.isArray(message.agentSteps)) {
      const stepCalls = message.agentSteps
        .filter((step) => Array.isArray(step?.toolCalls))
        .sort((left, right) => left.stepIndex - right.stepIndex)
        .flatMap((step) => step.toolCalls.filter((call) => typeof call?.toolName === 'string'));
      if (stepCalls.length) return getToolCalls({ ...message, toolCalls: stepCalls });
    }
    // 某些旧详情返回空数组，但配对的调用快照中仍保留了工具结果。
    if (message.toolCalls?.length === 0 && message.agentInvocation?.response) {
      try {
        return getToolCalls({ ...message, toolCalls: undefined });
      } catch {
        // 格式不完整的旧快照不应影响其余详情。
      }
    }
    return toolCalls;
  }, [toolCalls, message]);
  if (calls.length === 0) return null;

  return (
    <section className={styles.panel}>
      <h4 className={styles.sectionTitle}>工具执行</h4>
      <ul className={styles.toolList}>
        {calls.map((toolCall, index) => (
          <ToolExecutionItem
            key={toolCall.toolCallId ?? `${toolCall.name}-${index}`}
            toolCall={toolCall}
          />
        ))}
      </ul>
    </section>
  );
}
