import { useMemo, useState } from 'react';
import { ChevronRight, ListChecks } from 'lucide-react';
import { formatJson } from '@/utils/format';
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
          <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
          <code className={styles.toolName}>{toolCall.name}</code>
        </span>
        <span className={styles.toolMeta} lang="en">
          {toolCall.durationMs !== undefined ? (
            <span title={`${toolCall.durationMs} ms`}>
              {(toolCall.durationMs / 1000).toFixed(2)} s
            </span>
          ) : null}
          {toolCall.resultCount !== undefined && (
            <span>
              {toolCall.resultCount} {toolCall.resultCount === 1 ? 'result' : 'results'}
            </span>
          )}
          <span className={`${styles.statusBadge} ${getStatusClass(toolCall.status)}`}>
            {STATUS_LABELS[toolCall.status] ?? toolCall.status}
          </span>
        </span>
      </button>
      {expanded ? (
        <div className={styles.toolDetails}>
          {outcome && <p className={styles.outcome}>{outcome}</p>}
          {(toolCall.toolCallId || toolCall.errorType || toolCall.apiCode !== undefined) && (
            <div className={styles.diagnostics}>
              {toolCall.toolCallId && <code>调用 ID · {toolCall.toolCallId}</code>}
              {toolCall.errorType && <code>{toolCall.errorType}</code>}
              {toolCall.apiCode !== undefined && <code>apiCode={toolCall.apiCode}</code>}
            </div>
          )}
          {Boolean(toolCall.decisions?.length) && (
            <div className={styles.evidence}>
              <h5 className={styles.detailLabel}>执行经过</h5>
              <dl className={styles.evidenceList}>
                {toolCall.decisions?.map(({ label, detail }, index) => (
                  <div key={index}>
                    <dt>{label}</dt>
                    <dd>{detail}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {judgments.length > 0 ? (
            <div className={styles.evidence}>
              <h5 className={styles.detailLabel}>
                <ListChecks size={15} aria-hidden="true" />
                判断依据
              </h5>
              <dl className={styles.evidenceList}>
                {judgments.map(([label, detail], index) => (
                  <div key={index}>
                    <dt>{label}</dt>
                    <dd>{detail}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : !toolCall.decisions?.length && events.length === 0 ? (
            <p className={styles.emptyEvidence}>
              {toolCall.output == null ? '未记录工具返回值' : '仅记录最终结果'}
            </p>
          ) : null}
          {events.length > 0 && (
            <div className={styles.evidence}>
              <h5 className={styles.detailLabel}>相关观测</h5>
              <ul>
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
          {toolCall.input !== undefined && (
            <ReceiptPayload label="输入参数" value={toolCall.input} />
          )}
          {toolCall.output !== undefined && (
            <ReceiptPayload label="返回结果" value={toolCall.output} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function ReceiptPayload({ label, value }: { label: string; value: unknown }) {
  return (
    <div className={styles.payload}>
      <h5 className={styles.detailLabel}>{label}</h5>
      <pre>{typeof value === 'string' ? value : formatJson(value)}</pre>
    </div>
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
