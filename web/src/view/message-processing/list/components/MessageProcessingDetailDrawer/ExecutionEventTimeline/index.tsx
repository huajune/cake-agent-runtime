import type { ExecutionEvent } from '@/api/types/chat.types';
import { formatDuration } from '@/utils/format';
import styles from './index.module.scss';

interface ExecutionEventTimelineProps {
  events: ExecutionEvent[];
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
      const attemptCount = typeof payload.attemptCount === 'number' ? payload.attemptCount : undefined;
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
    case 'guardrail_repair': {
      const firstRuleIds = Array.isArray(payload.firstRuleIds)
        ? payload.firstRuleIds.filter((item): item is string => typeof item === 'string')
        : [];
      return [
        asString(payload.outcome),
        asString(payload.finalDecision),
        firstRuleIds.length > 0 ? `rules=${firstRuleIds.join(',')}` : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'inbound_guardrail_block':
      return [asString(payload.reasonCode), asString(payload.riskLabel) ?? asString(payload.riskType)]
        .filter(Boolean)
        .join(' · ');
    case 'semantic_review':
      return [asString(payload.mode), asString(payload.decision), asString(payload.confidence)]
        .filter(Boolean)
        .join(' · ');
    default:
      if (event.type.startsWith('collection_')) {
        const labelId = asString(payload.labelId);
        return [asString(payload.reason), labelId ? `labelId=${labelId}` : undefined]
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

function stringifyPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return '[无法序列化 payload]';
  }
}

export default function ExecutionEventTimeline({ events }: ExecutionEventTimelineProps) {
  const baseTime = events.length > 0 ? Date.parse(events[0].createdAt) : Number.NaN;

  return (
    <section>
      <h4 className={styles.sectionTitle}>执行事件</h4>
      <div className={styles.timelineCard}>
        {events.length === 0 ? (
          <div className={styles.emptyState}>该回合没有执行事件</div>
        ) : (
          <ol className={styles.timelineList}>
            {events.map((event) => {
              const summary = summarizeEvent(event);
              // llm_execution 有重试/降级时，摘要之外仍展开原始 payload——attempts 轨迹
              // （每次尝试的耗时/错误分类/退避）正是该事件的排障主体。
              const showRawWithSummary =
                event.type === 'llm_execution' &&
                Array.isArray(event.payload.attempts) &&
                event.payload.attempts.length > 1;
              return (
                <li key={event.id} className={styles.timelineItem}>
                  <div className={styles.timelineMarker} />
                  <div className={styles.eventBody}>
                    <div className={styles.eventHeader}>
                      <time className={styles.relativeTime} dateTime={event.createdAt}>
                        {formatRelativeTime(event.createdAt, baseTime)}
                      </time>
                      <span className={styles.eventBadge}>{event.type}</span>
                    </div>
                    {summary ? <div className={styles.eventSummary}>{summary}</div> : null}
                    {!summary || showRawWithSummary ? (
                      <details className={styles.rawDetails}>
                        <summary>查看原始 JSON</summary>
                        <pre>{stringifyPayload(event.payload)}</pre>
                      </details>
                    ) : null}
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
