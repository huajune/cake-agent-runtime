import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatDuration, formatJson, formatToolResult } from '@/utils/format';
import type { MessageRecordToolCallStatus } from '@/api/types/chat.types';
import type { ToolCallInfo } from '../utils';
import styles from './index.module.scss';

interface ToolExecutionPanelProps {
  toolCalls: ToolCallInfo[];
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
  const hasDetails = toolCall.input !== undefined || toolCall.output !== undefined;

  return (
    <li className={styles.toolItem}>
      <button
        type="button"
        className={styles.toolHeader}
        disabled={!hasDetails}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.toolIdentity}>
          {hasDetails ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
          <span className={styles.toolName}>{toolCall.name}</span>
        </span>
        <span className={styles.toolMeta}>
          {toolCall.durationMs !== undefined ? (
            <span>{formatDuration(toolCall.durationMs)}</span>
          ) : null}
          {toolCall.resultCount !== undefined ? <span>{toolCall.resultCount} 条</span> : null}
          {toolCall.errorType ? <span>{toolCall.errorType}</span> : null}
          {toolCall.apiCode !== undefined ? <span>apiCode={toolCall.apiCode}</span> : null}
          <span className={`${styles.statusBadge} ${getStatusClass(toolCall.status)}`}>
            {STATUS_LABELS[toolCall.status]}
          </span>
        </span>
      </button>
      {expanded ? (
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
              <pre>{formatToolResult(toolCall.output)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function ToolExecutionPanel({ toolCalls }: ToolExecutionPanelProps) {
  if (toolCalls.length === 0) return null;

  return (
    <section className={styles.panel}>
      <h4 className={styles.sectionTitle}>工具执行</h4>
      <ul className={styles.toolList}>
        {toolCalls.map((toolCall, index) => (
          <ToolExecutionItem
            key={toolCall.toolCallId ?? `${toolCall.name}-${index}`}
            toolCall={toolCall}
          />
        ))}
      </ul>
    </section>
  );
}
