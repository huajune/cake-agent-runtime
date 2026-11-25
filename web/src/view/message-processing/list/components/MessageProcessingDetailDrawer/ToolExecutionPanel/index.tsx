import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatDuration, formatJson } from '@/utils/format';
import type { ExecutionEvent, MessageRecordToolCallStatus } from '@/api/types/chat.types';
import { describeToolExecution } from '@/view/message-processing/tool-execution';
import type { ToolCallInfo } from '../utils';
import styles from './index.module.scss';

interface ToolExecutionPanelProps {
  toolCalls: ToolCallInfo[];
  events: readonly ExecutionEvent[];
  links: ReadonlyMap<number, number>;
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

function ToolExecutionItem({
  toolCall,
  events,
}: {
  toolCall: ToolCallInfo;
  events: ExecutionEvent[];
}) {
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
            {toolCall.toolCallId && (
              <div>
                <div className={styles.detailLabel}>调用 ID</div>
                <code>{toolCall.toolCallId}</code>
              </div>
            )}
            {toolCall.decisions?.length ? (
              <div>
                <div className={styles.detailLabel}>执行经过</div>
                <ol className={styles.toolList}>
                  {toolCall.decisions.map(({ label, detail }, index) => (
                    <li key={index}>
                      {label} · {detail}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            {judgments.length > 0 ? (
              <div>
                <div className={styles.detailLabel}>本次判断</div>
                <ul className={styles.toolList}>
                  {judgments.map((judgment, index) => (
                    <li key={index}>{judgment}</li>
                  ))}
                </ul>
              </div>
            ) : !toolCall.decisions?.length && events.length === 0 ? (
              <div>{toolCall.output == null ? '未记录工具返回值' : '仅记录最终结果'}</div>
            ) : null}
            {events.length > 0 && (
              <div>
                <div className={styles.detailLabel}>相关观测</div>
                <ul className={styles.toolList}>
                  {events.map((event) => (
                    <li key={event.id}>
                      <a
                        href={`#execution-event-${event.id}`}
                        onClick={(click) => {
                          click.preventDefault();
                          document.getElementById(`execution-event-${event.id}`)?.focus();
                        }}
                      >
                        {event.observationReason ?? event.type}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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

export default function ToolExecutionPanel({
  toolCalls: calls,
  events,
  links,
}: ToolExecutionPanelProps) {
  if (calls.length === 0) return null;

  return (
    <section className={styles.panel}>
      <h4 className={styles.sectionTitle}>工具执行</h4>
      <ul className={styles.toolList}>
        {calls.map((toolCall, index) => (
          <ToolExecutionItem
            key={`${toolCall.toolCallId ?? toolCall.name}-${index}`}
            events={events.filter((event) => links.get(event.id) === index)}
            toolCall={toolCall}
          />
        ))}
      </ul>
    </section>
  );
}
