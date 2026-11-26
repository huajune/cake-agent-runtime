import { useState } from 'react';
import type { ExecutionEvent } from '@/api/types/chat.types';
import { guardrailInputDisplay } from '@/components/GuardrailTrace/outcome';
import { formatDuration } from '@/utils/format';
import styles from './index.module.scss';

interface ExecutionEventTimelineProps {
  events?: ExecutionEvent[];
  links: Map<number, number>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function getBrandStateLabel(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '∅';
  const state = value as Record<string, unknown>;
  const currentBrand = state.currentBrand;
  if (!currentBrand || typeof currentBrand !== 'object' || Array.isArray(currentBrand)) {
    return '全品牌';
  }
  return asString((currentBrand as Record<string, unknown>).canonicalName) ?? '未知品牌';
}

function summarizeEvent(event: ExecutionEvent): string | undefined {
  const payload = event.payload;
  switch (event.type) {
    case 'model_fallback': {
      const fromModel = asString(payload.fromModel);
      const toModel = asString(payload.toModel);
      const reason = asString(payload.reason);
      return [fromModel && toModel ? `${fromModel} → ${toModel}` : undefined, reason]
        .filter(Boolean)
        .join(' · ');
    }
    case 'tool_call':
    case 'tool_error': {
      const toolName = asString(payload.toolName);
      const status = asString(payload.status);
      const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : undefined;
      const errorType = asString(payload.errorType) ?? asString(payload.error);
      return [
        toolName,
        status,
        durationMs !== undefined ? formatDuration(durationMs) : undefined,
        errorType,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'llm_execution': {
      const model = asString(payload.finalModelId) ?? asString(payload.primaryModelId);
      const attemptCount =
        typeof payload.attemptCount === 'number' ? payload.attemptCount : undefined;
      const totalDurationMs =
        typeof payload.totalDurationMs === 'number' ? payload.totalDurationMs : undefined;
      return [
        model,
        asString(payload.status),
        attemptCount !== undefined ? `${attemptCount}次尝试` : undefined,
        totalDurationMs !== undefined ? formatDuration(totalDurationMs) : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'brand_state_change':
      return `${getBrandStateLabel(payload.prev)} → ${getBrandStateLabel(payload.next)}`;
    case 'session_state_field_dropped':
      return asString(payload.field);
    case 'schedule_extraction_disagreement':
      return [
        asString(payload.extraction),
        ...(Array.isArray(payload.toolChangedFields)
          ? payload.toolChangedFields.filter((item) => typeof item === 'string')
          : []),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'prompt_injection_detected':
      return [asString(payload.ruleId), asString(payload.alertStatus)].filter(Boolean).join(' · ');
    case 'agent_error':
      return asString(payload.error);
    case 'guardrail_repair': {
      const firstRuleIds = Array.isArray(payload.firstRuleIds)
        ? payload.firstRuleIds.filter((item): item is string => typeof item === 'string')
        : [];
      return [
        asString(payload.outcome),
        asString(payload.finalOutcome) ?? asString(payload.finalDecision),
        firstRuleIds.length > 0 ? `rules=${firstRuleIds.join(',')}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'inbound_guardrail_handoff':
    // 只读兼容旧持久事件；现役 Observer 不再接受此类型。
    case 'inbound_guardrail_block':
      return [
        guardrailInputDisplay(event.type === 'inbound_guardrail_handoff' ? 'handoff' : 'block')
          .label,
        asString(payload.reasonCode),
        asString(payload.riskLabel) ?? asString(payload.riskType),
      ]
        .filter(Boolean)
        .join(' · ');
    case 'semantic_review':
      return [asString(payload.mode), asString(payload.decision), asString(payload.confidence)]
        .filter(Boolean)
        .join(' · ');
    default:
      if (event.type.startsWith('collection_')) {
        const labelId = asString(payload.labelId);
        const jobId = asString(payload.jobId);
        return [
          jobId && `岗位 ${jobId}`,
          asString(payload.kind),
          asString(payload.labelTitle),
          labelId && `字段 ${labelId}`,
          asString(payload.reason),
          asString(payload.detail),
        ]
          .filter(Boolean)
          .join(' · ');
      }
      return undefined;
  }
}

function formatRelativeTime(createdAt: string, baseTime: number): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(baseTime)) return createdAt;
  return `+${formatDuration(Math.max(0, timestamp - baseTime))}`;
}

function EventPayload({ payload }: { payload: ExecutionEvent['payload'] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.rawDetails} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>查看事件字段</summary>
      {open && <pre>{JSON.stringify(payload, null, 2)}</pre>}
    </details>
  );
}

export default function ExecutionEventTimeline({ events, links }: ExecutionEventTimelineProps) {
  const baseTime = events?.length ? Date.parse(events[0].createdAt) : Number.NaN;

  return (
    <section>
      <h4 className={styles.sectionTitle}>排障观测事件</h4>
      <div className={styles.timelineCard}>
        <div className={styles.emptyState}>
          用于复盘 bad
          case。这里会记录异常线索，也会记录成功的业务动作、模型尝试和回合收尾。工具调用清单见「工具执行」。
        </div>
        {!events?.length ? (
          <div className={styles.emptyState}>
            {events ? '本次查询没有返回观测事件。' : '此详情未提供观测事件。'}
          </div>
        ) : (
          <ol className={styles.timelineList}>
            {events.map((event) => {
              const callIndex = links.get(event.id);
              const linkedCompletion =
                callIndex !== undefined &&
                (event.type === 'tool_call' || event.type === 'tool_error');
              const summary = linkedCompletion
                ? (asString(event.payload.error) ?? asString(event.payload.errorType))
                : summarizeEvent(event);
              return (
                <li
                  key={event.id}
                  id={`execution-event-${event.id}`}
                  tabIndex={-1}
                  className={styles.timelineItem}
                >
                  <div className={styles.timelineMarker} />
                  <div className={styles.eventBody}>
                    <div className={styles.eventHeader}>
                      <time className={styles.relativeTime} dateTime={event.createdAt}>
                        {formatRelativeTime(event.createdAt, baseTime)}
                      </time>
                      <span className={styles.eventBadge}>{event.type}</span>
                    </div>
                    {event.observationReason && (
                      <div className={styles.eventSummary}>{event.observationReason}</div>
                    )}
                    {callIndex !== undefined && (
                      <div className={styles.eventSummary}>
                        对应第 {callIndex + 1} 次工具调用 ·{' '}
                        {asString(event.payload.toolName) ?? '见「工具执行」'}
                      </div>
                    )}
                    {summary ? <div className={styles.eventSummary}>{summary}</div> : null}
                    <EventPayload payload={event.payload} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
