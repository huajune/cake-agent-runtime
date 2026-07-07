import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { formatDateTime, formatJson } from '@/utils/format';
import {
  useReengagementRecordDetail,
  useReengagementRecords,
} from '@/hooks/reengagement/useReengagementRecords';
import { useChatSessionMessages } from '@/hooks/chat/useChatSessions';
import type { ReengagementEvent, ReengagementTouchRecord } from '@/api/types/reengagement.types';
import { getStatusMeta } from '../../constants';
import StatusBadge from '../StatusBadge';
import styles from './index.module.scss';

/** 详情里展示更完整的触达前后语境 */
const RECENT_CHAT_LIMIT = 50;

interface ReengagementDetailDrawerProps {
  touchKey: string;
  onClose: () => void;
  onTouchSelect?: (touchKey: string) => void;
  /** code→displayName，由页面从场景注册表接口构建（与 /config 页同源） */
  scenarioLabels: Record<string, string>;
}

interface InfoFact {
  label: string;
  value: string;
  mono?: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  scheduled: '已创建待发任务',
  schedule_precheck_stopped: '排程前已停止',
  enqueue_error: '入队失败',
  fired_but_disabled: '到点时开关关闭',
  stopped: '到点时停止',
  frequency_blocked: '被频控拦截',
  rescheduled_out_of_window: '不在可发送时段，已改期',
  shadow_generated: 'Shadow 回合完成（未投递）',
  reserve_duplicate: '撞重跳过',
  reserved: '已占用触达槽',
  outcome_not_reply: '生成结果不是可发送回复',
  delivery_attempted: '开始投递',
  sent: '投递成功',
  delivery_unknown: '投递状态不明',
};

const DETAIL_REASON_LABELS: Record<string, string> = {
  no_delivery_port: '没有实际投递通道',
  shadow_mode: 'Shadow 模式只生成不发送',
  rollout_disabled: '灰度未开启',
  reengagement_disabled: '复聊总开关关闭',
  over_frequency_limit_24h: '24 小时频控已达上限',
};

const OUTCOME_LABELS: Record<string, string> = {
  reply: '生成了可发送回复',
  skipped: '未产出可发送回复',
  guardrail_blocked: '被安全规则拦截',
  handoff: '转人工',
};

function formatMaybeTime(value?: string | null): string {
  return value ? formatDateTime(value) : '-';
}

function readString(detail: Record<string, unknown> | undefined, key: string): string | null {
  const value = detail?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(detail: Record<string, unknown> | undefined, key: string): number | null {
  const value = detail?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatMaybeEpoch(value: number | null): string | null {
  return value ? formatDateTime(new Date(value).toISOString()) : null;
}

function sortEventsAsc(events: ReengagementEvent[]): ReengagementEvent[] {
  // 防御 events 数组里的 null 元素（record RPC 旧版本在无 event 写入时会落 [null]）
  return events.filter(Boolean).sort((a, b) => {
    const at = Date.parse(a.at);
    const bt = Date.parse(b.at);
    return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
  });
}

function sortRecordsByCreatedAt(records: ReengagementTouchRecord[]): ReengagementTouchRecord[] {
  return [...records].sort((a, b) => {
    const at = Date.parse(a.created_at || '');
    const bt = Date.parse(b.created_at || '');
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
}

function getEventLabel(event: ReengagementEvent): string {
  return EVENT_LABELS[event.event] ?? event.event;
}

function getEventSummary(event: ReengagementEvent): string {
  const reason = readString(event.detail, 'reason');
  const outcomeKind = readString(event.detail, 'outcomeKind');
  const fireAt = formatMaybeEpoch(readNumber(event.detail, 'fireAt'));
  const nextFireAt = formatMaybeEpoch(readNumber(event.detail, 'nextFireAt'));

  if (event.event === 'scheduled') {
    return fireAt ? `系统创建了一次复聊任务，计划在 ${fireAt} 触发。` : '系统创建了一次复聊任务。';
  }

  if (event.event === 'schedule_precheck_stopped') {
    return reason
      ? `创建任务前预检没通过：${DETAIL_REASON_LABELS[reason] || reason}。`
      : '创建任务前预检没通过。';
  }

  if (event.event === 'rescheduled_out_of_window') {
    return nextFireAt
      ? `到点时不在 9:00-21:00 可发送时段，已改到 ${nextFireAt}。`
      : '到点时不在 9:00-21:00 可发送时段，已改期。';
  }

  if (event.event === 'shadow_generated') {
    const reasonText = reason ? DETAIL_REASON_LABELS[reason] || reason : '未投递';
    const outcomeText = outcomeKind ? OUTCOME_LABELS[outcomeKind] || outcomeKind : '已生成结果';
    return `${outcomeText}，但因为「${reasonText}」，所以没有发给用户。`;
  }

  if (event.event === 'reserved') return '系统已锁定这次发送机会，避免并发任务重复触达。';
  if (event.event === 'reserve_duplicate')
    return '同一触达槽已经有任务或发送记录，这次被幂等保护跳过。';
  if (event.event === 'delivery_attempted') return '文案已进入外部渠道发送流程。';
  if (event.event === 'sent') return '复聊消息已通过渠道发出。';
  if (event.event === 'delivery_unknown') return '渠道侧返回异常，不能盲目重发，需要人工核对。';
  if (event.event === 'frequency_blocked')
    return '为了避免同一候选人被过度打扰，这次触达被频控拦截。';
  if (event.event === 'fired_but_disabled')
    return '任务到了触发时间，但复聊总开关已关闭，所以没有继续执行。';
  if (event.event === 'stopped') return '任务到点后发现候选人已回复、状态已变化，或场景不再成立。';
  if (event.event === 'outcome_not_reply')
    return '主动回合没有产出可投递的回复，因此没有给候选人发消息。';
  if (event.event === 'enqueue_error') return '任务写入队列失败，需要看技术明细里的错误。';
  if (reason) return DETAIL_REASON_LABELS[reason] || reason;
  if (outcomeKind) return OUTCOME_LABELS[outcomeKind] || outcomeKind;
  return '系统记录了这一步的处理状态。';
}

export default function ReengagementDetailDrawer({
  touchKey,
  onClose,
  onTouchSelect,
  scenarioLabels,
}: ReengagementDetailDrawerProps) {
  const navigate = useNavigate();
  const { data: record, isLoading, isError } = useReengagementRecordDetail(touchKey);

  const events = useMemo(() => sortEventsAsc(record?.events || []), [record?.events]);
  const detailBatchId = record?.batch_id || null;
  const { data: sessionRecords, isLoading: sessionRecordsLoading } = useReengagementRecords({
    sessionId: record?.session_id ?? undefined,
    limit: 50,
    enabled: !!record?.session_id,
  });
  const sameSessionRecords = useMemo(
    () => sortRecordsByCreatedAt(sessionRecords ?? []),
    [sessionRecords],
  );

  // 最近聊天记录：还原触达前后的会话语境
  const { data: chatData, isLoading: chatLoading } = useChatSessionMessages(
    record?.session_id ?? null,
  );
  const recentMessages = useMemo(
    () => (chatData?.messages ?? []).slice(-RECENT_CHAT_LIMIT),
    [chatData?.messages],
  );

  const identityFacts = useMemo<InfoFact[]>(() => {
    if (!record) return [];
    return [
      { label: 'Touch Key', value: record.touch_key, mono: true },
      { label: 'Session', value: record.session_id || '-', mono: true },
      { label: 'User', value: record.user_id || '-', mono: true },
      { label: 'Corp', value: record.corp_id || '-', mono: true },
      { label: '场景', value: scenarioLabels[record.scenario_code] ?? record.scenario_code ?? '-' },
      { label: '决策原因', value: record.decision_reason || '-' },
      { label: 'Outcome', value: record.outcome_kind || '-' },
      { label: 'Reserve', value: record.reserve_result || '-' },
      { label: '主动回合 Batch', value: detailBatchId || '-', mono: true },
    ];
  }, [detailBatchId, record, scenarioLabels]);

  const timeFacts = useMemo<InfoFact[]>(() => {
    if (!record) return [];
    return [
      { label: '锚点时间', value: formatMaybeTime(record.anchor_at) },
      { label: '排程时间', value: formatMaybeTime(record.scheduled_at) },
      { label: '计划触发', value: formatMaybeTime(record.fire_at) },
      { label: '实际触发', value: formatMaybeTime(record.fired_at) },
      { label: '投递时间', value: formatMaybeTime(record.sent_at) },
      { label: '创建时间', value: formatMaybeTime(record.created_at) },
      { label: '更新时间', value: formatMaybeTime(record.updated_at) },
    ];
  }, [record]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (isLoading || !record) {
    return (
      <div className="drawer-overlay" onClick={handleOverlayClick}>
        <div className="drawer-content">
          <div className={styles.header}>
            <div className={styles.headerTop}>
              <h3 className={styles.headerTitle}>触达记录详情</h3>
              <button className={styles.closeBtn} onClick={onClose}>
                &times;
              </button>
            </div>
          </div>
          <div className={styles.loadingBody}>
            {isLoading ? '加载中...' : isError ? '详情加载失败，请关闭后重试' : '未找到触达详情'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="drawer-overlay" onClick={handleOverlayClick}>
      <div className="drawer-content">
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerTop}>
            <h3 className={styles.headerTitle}>触达记录详情</h3>
            <StatusBadge status={record.status} title={record.error || undefined} />
            {record.shadow && record.status !== 'shadow' && (
              <span className={styles.shadowFlag} title="Shadow：生成了文案但未投递">
                Shadow
              </span>
            )}
            <button className={styles.closeBtn} onClick={onClose}>
              &times;
            </button>
          </div>
        </div>

        {/* Body — left/right split */}
        <div className={styles.body}>
          <div className={styles.leftCol}>
            {/* Error */}
            {record.error && (
              <div className={styles.errorBox}>
                <div className={styles.errorTitle}>错误信息</div>
                <div className={styles.errorText}>{record.error}</div>
              </div>
            )}

            {/* Recent chat context */}
            <div>
              <div className={styles.sectionTitle}>
                最近聊天记录
                <span className={styles.sectionNote}>近 {RECENT_CHAT_LIMIT} 条</span>
              </div>
              {chatLoading ? (
                <div className={styles.emptyText}>加载中...</div>
              ) : recentMessages.length === 0 ? (
                <div className={styles.emptyText}>暂无聊天记录</div>
              ) : (
                <div className={styles.historyCard}>
                  <div className={styles.historyList}>
                    {recentMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`${styles.historyItem} ${
                          msg.role === 'assistant' ? styles.historyAssistant : styles.historyUser
                        }`}
                      >
                        <div className={styles.historyMeta}>
                          <span className={styles.historyRole}>
                            {msg.role === 'assistant' ? 'Agent' : '用户'}
                          </span>
                          <span className={styles.historyName}>
                            {msg.role === 'assistant'
                              ? msg.managerName || '接管账号'
                              : msg.candidateName || '候选人'}
                          </span>
                          <span className={styles.historyTime}>
                            {formatDateTime(msg.timestamp)}
                          </span>
                        </div>
                        <div className={styles.historyContent}>{msg.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Generated text */}
            <div>
              <div className={styles.sectionTitle}>
                生成文案
                {record.shadow && <span className={styles.shadowNote}>本应发（未投递）</span>}
              </div>
              {record.generated_text ? (
                <div className={styles.generatedText}>{record.generated_text}</div>
              ) : (
                <div className={styles.emptyText}>
                  {record.outcome_kind === 'skipped'
                    ? '未产出可发送文案（Outcome=skipped）'
                    : '未生成文案'}
                </div>
              )}
            </div>

            {/* Same session tasks */}
            <div>
              <div className={styles.sectionTitle}>
                同候选人复聊任务
                {!sessionRecordsLoading && (
                  <span className={styles.sectionNote}>共 {sameSessionRecords.length} 条</span>
                )}
              </div>
              {sessionRecordsLoading ? (
                <div className={styles.emptyText}>加载中...</div>
              ) : sameSessionRecords.length === 0 ? (
                <div className={styles.emptyText}>暂无同候选人任务</div>
              ) : (
                <div className={styles.taskList}>
                  {sameSessionRecords.map((task) => {
                    const statusMeta = getStatusMeta(task.status);
                    const isCurrent = task.touch_key === record.touch_key;
                    return (
                      <button
                        key={task.touch_key}
                        type="button"
                        className={`${styles.taskItem} ${isCurrent ? styles.taskItemActive : ''}`}
                        disabled={isCurrent || !onTouchSelect}
                        onClick={() => onTouchSelect?.(task.touch_key)}
                        title={task.touch_key}
                      >
                        <span className={styles.taskMain}>
                          <span className={styles.taskScenario}>
                            {scenarioLabels[task.scenario_code] ?? task.scenario_code}
                          </span>
                          <StatusBadge
                            status={task.status}
                            title={task.decision_reason || statusMeta.label}
                          />
                          {isCurrent && <span className={styles.currentTaskMark}>当前查看</span>}
                        </span>
                        <span className={styles.taskMeta}>
                          {task.fire_at
                            ? `计划触发 ${formatDateTime(task.fire_at)}`
                            : '无计划触发时间'}
                        </span>
                        {task.decision_reason && (
                          <span className={styles.taskReason}>原因：{task.decision_reason}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Lifecycle timeline */}
            <div>
              <div className={styles.sectionTitle}>当前任务流转</div>
              {events.length === 0 ? (
                <div className={styles.emptyText}>暂无事件轨迹</div>
              ) : (
                <div className={styles.timeline}>
                  {events.map((event, index) => (
                    <div
                      key={`${event.at}-${event.event}-${index}`}
                      className={styles.timelineItem}
                    >
                      <div className={styles.timelineDot} />
                      <div className={styles.timelineContent}>
                        <div className={styles.timelineHead}>
                          <span className={styles.timelineEvent}>{getEventLabel(event)}</span>
                          <span className={styles.timelineTime}>{formatDateTime(event.at)}</span>
                        </div>
                        <div className={styles.timelineSummary}>{getEventSummary(event)}</div>
                        {event.detail && Object.keys(event.detail).length > 0 && (
                          <details className={styles.timelineDetail}>
                            <summary>技术明细</summary>
                            <pre>{formatJson(event.detail)}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className={styles.rightCol}>
            {/* 该触达由哪个主动回合投递：跳消息处理流水详情 */}
            {detailBatchId && (
              <button
                type="button"
                className={styles.batchLink}
                onClick={() =>
                  navigate(`/message-processing?messageId=${encodeURIComponent(detailBatchId)}`)
                }
                title={`Batch: ${detailBatchId}`}
              >
                <ExternalLink aria-hidden="true" size={13} />
                查看消息处理流水
              </button>
            )}
            {/* Identity facts */}
            <div className={styles.sideTitle}>基本信息</div>
            <div className={styles.factList}>
              {identityFacts.map((fact) => (
                <div key={fact.label} className={styles.factRow}>
                  <span className={styles.factLabel}>{fact.label}</span>
                  <span className={`${styles.factValue} ${fact.mono ? styles.monoValue : ''}`}>
                    {fact.value}
                  </span>
                </div>
              ))}
            </div>

            {/* Time facts */}
            <div className={styles.sideTitle}>时间戳</div>
            <div className={styles.factList}>
              {timeFacts.map((fact) => (
                <div key={fact.label} className={styles.factRow}>
                  <span className={styles.factLabel}>{fact.label}</span>
                  <span className={styles.factValue}>{fact.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
