import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  Info,
  MessageSquareText,
  XCircle,
} from 'lucide-react';
import { formatDateTime, formatJson } from '@/utils/format';
import {
  useReengagementRecordDetail,
  useReengagementRecords,
} from '@/hooks/reengagement/useReengagementRecords';
import { useMessageProcessingRecordDetail } from '@/hooks/chat/useMessageProcessingRecords';
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

interface SummaryInfo {
  title: string;
  description: string;
  tone: 'pending' | 'success' | 'muted' | 'warning' | 'danger';
  icon: 'clock' | 'check' | 'stop' | 'info';
}

/** 从主动回合 agentRequest 还原的生成内幕（模型思考 + 提示词） */
interface GenerationInsight {
  /** 模型自述的生成依据（reengagement agent 结构化输出的 reason 字段） */
  reason?: string;
  /** extended thinking / agentSteps 里的思考过程 */
  thinking?: string;
  modelId?: string;
  fallbackModelIds?: string[];
  systemPrompt?: string;
  /** 老版本模板档（未调用 LLM）标记 */
  isTemplate: boolean;
  validationReason?: string;
  usageText?: string;
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
  superseded: '已被新任务替代',
};

const DETAIL_REASON_LABELS: Record<string, string> = {
  no_delivery_port: '没有实际投递通道',
  shadow_mode: 'Shadow 模式只生成不发送',
  rollout_disabled: '灰度未开启',
  scenario_rollout_disabled: '该场景灰度未开启，只生成不发送',
  reengagement_disabled: '复聊总开关关闭',
  over_frequency_limit_24h: '24 小时频控已达上限',
  candidate_replied_after_anchor: '候选人已经回复，所以不再追问',
  scenario_no_longer_holds: '当前会话状态已不满足这个复聊场景',
  session_touch_cooldown: '同一候选人 2 小时内已有一次复聊，已自动跳过',
  superseded_by_new_task: '候选人出现了新的复聊任务，这条旧任务已自动取消',
  removed_pending_job: '任务已被系统取消',
  composer_empty: '生成器没有产出可发送内容',
  composer_skip: '生成器判断这次不适合主动跟进',
  composer_error: '生成文案时发生异常',
  composer_too_long: '生成文案过长，已拦截',
  composer_validation_failed: '生成文案疑似包含内部信息，已拦截',
  composer_forbidden_job_detail: '轻量复聊里出现了薪资、班次或岗位详情，已拦截',
  composer_missing_expected_ask: '生成文案没有命中这个场景需要追问的要点，已拦截',
  candidate_cancelled_interview_in_chat: '候选人在聊天中已明确取消或无法参加面试，已停止触达',
  reengagement_agent_error: '复聊生成调用异常',
};

const OUTCOME_LABELS: Record<string, string> = {
  reply: '生成了可发送回复',
  skipped: '未产出可发送回复',
  guardrail_blocked: '被安全规则拦截',
  handoff: '转人工',
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

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

function formatReason(reason?: string | null): string {
  if (!reason) return '-';
  if (DETAIL_REASON_LABELS[reason]) return DETAIL_REASON_LABELS[reason];
  if (reason.startsWith('terminal:')) return `会话已进入终态：${reason.slice('terminal:'.length)}`;
  if (reason.startsWith('external_cancelled:'))
    return `报名已取消：${reason.slice('external_cancelled:'.length)}`;
  if (reason.startsWith('interview_already_done:'))
    return `面试已有结果：${reason.slice('interview_already_done:'.length)}`;
  if (reason.startsWith('delivery_skipped:'))
    return `渠道未实际投递：${reason.slice('delivery_skipped:'.length)}`;
  return reason;
}

function getReadableStatus(record: ReengagementTouchRecord): SummaryInfo {
  const scenario = record.scenario_code;
  const reason = formatReason(record.decision_reason);
  const fireAt = formatMaybeTime(record.fire_at);
  const sentAt = formatMaybeTime(record.sent_at);

  if (record.status === 'scheduled' || record.status === 'rescheduled') {
    return {
      title: '等待触发',
      description:
        fireAt === '-'
          ? '系统已经创建了这次复聊任务，还没有到触发时间。'
          : `系统计划在 ${fireAt} 触发这次复聊；到点后会再检查候选人是否已回复、场景是否仍成立。`,
      tone: 'pending',
      icon: 'clock',
    };
  }
  if (record.status === 'sent') {
    return {
      title: '已经发给候选人',
      description: sentAt === '-' ? '这次复聊已经通过渠道发出。' : `这次复聊已在 ${sentAt} 发出。`,
      tone: 'success',
      icon: 'check',
    };
  }
  if (record.status === 'shadow') {
    return {
      title: '只观测，未发送',
      description: `系统生成了“本来会发”的内容，但当前处于观测模式或无投递通道，所以没有发给候选人。原因：${reason}`,
      tone: 'muted',
      icon: 'info',
    };
  }
  if (record.status === 'superseded') {
    return {
      title: '已被新任务替代',
      description:
        reason === '-'
          ? '候选人出现了新的复聊任务，这条还没到点的旧任务已经自动取消，不会再发送。'
          : reason,
      tone: 'muted',
      icon: 'stop',
    };
  }
  if (record.status === 'stopped' || record.status === 'skipped' || record.status === 'disabled') {
    return {
      title: '不会发送',
      description: reason === '-' ? `这次 ${scenario} 复聊已停止。` : reason,
      tone: 'muted',
      icon: 'stop',
    };
  }
  if (record.status === 'frequency_blocked' || record.status === 'duplicate') {
    return {
      title: '被保护规则跳过',
      description: reason === '-' ? '为了避免重复或过度打扰，这次没有发送。' : reason,
      tone: 'warning',
      icon: 'stop',
    };
  }
  if (record.status === 'failed' || record.status === 'unknown') {
    return {
      title: record.status === 'unknown' ? '投递状态不明' : '执行失败',
      description: record.error || (reason === '-' ? '需要查看技术明细进一步排查。' : reason),
      tone: 'danger',
      icon: 'stop',
    };
  }
  return {
    title: '已记录',
    description: reason === '-' ? '系统记录了这次复聊任务。' : reason,
    tone: 'muted',
    icon: 'info',
  };
}

function SummaryIcon({ icon }: { icon: SummaryInfo['icon'] }) {
  if (icon === 'clock') return <Clock aria-hidden="true" size={18} />;
  if (icon === 'check') return <CheckCircle2 aria-hidden="true" size={18} />;
  if (icon === 'stop') return <XCircle aria-hidden="true" size={18} />;
  return <Info aria-hidden="true" size={18} />;
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
    return reason ? `创建任务前预检没通过：${formatReason(reason)}。` : '创建任务前预检没通过。';
  }

  if (event.event === 'rescheduled_out_of_window') {
    return nextFireAt
      ? `到点时不在 9:00-21:00 可发送时段，已改到 ${nextFireAt}。`
      : '到点时不在 9:00-21:00 可发送时段，已改期。';
  }

  if (event.event === 'shadow_generated') {
    const reasonText = reason ? formatReason(reason) : '未投递';
    const outcomeText = outcomeKind ? OUTCOME_LABELS[outcomeKind] || outcomeKind : '已生成结果';
    return `${outcomeText}，但因为「${reasonText}」，所以没有发给用户。`;
  }

  if (event.event === 'reserved') return '系统已锁定这次发送机会，避免并发任务重复触达。';
  if (event.event === 'reserve_duplicate')
    return '同一触达槽已经有任务或发送记录，这次被幂等保护跳过。';
  if (event.event === 'delivery_attempted') return '文案已进入外部渠道发送流程。';
  if (event.event === 'sent') return '复聊消息已通过渠道发出。';
  if (event.event === 'delivery_unknown') return '渠道侧返回异常，不能盲目重发，需要人工核对。';
  if (event.event === 'superseded')
    return reason
      ? `候选人出现了新的复聊任务，这条旧任务已取消：${formatReason(reason)}。`
      : '候选人出现了新的复聊任务，这条还没到点的旧任务已自动取消。';
  if (event.event === 'frequency_blocked')
    return '为了避免同一候选人被过度打扰，这次触达被频控拦截。';
  if (event.event === 'fired_but_disabled')
    return '任务到了触发时间，但复聊总开关已关闭，所以没有继续执行。';
  if (event.event === 'stopped') return '任务到点后发现候选人已回复、状态已变化，或场景不再成立。';
  if (event.event === 'outcome_not_reply')
    return '主动回合没有产出可投递的回复，因此没有给候选人发消息。';
  if (event.event === 'enqueue_error') return '任务写入队列失败，需要看技术明细里的错误。';
  if (reason) return formatReason(reason);
  if (outcomeKind) return OUTCOME_LABELS[outcomeKind] || outcomeKind;
  return '系统记录了这一步的处理状态。';
}

/**
 * 从主动回合流水（agent_invocation）里抽出「模型思考 + 提示词」。
 *
 * agentRequest 三种形态：
 * - 新版 ReengagementAgent：{modelId, system, messages, reengagementInput, reengagementOutput:{message,reason}}
 * - 旧版 composer 模板档：{type:'template', scenarioCode}（无 LLM 调用）
 * - 旧版 composer LLM 档：{modelId, system, messages}（无结构化 reason）
 */
function extractGenerationInsight(
  invocationRequest: AnyRecord | undefined,
  invocationResponse: AnyRecord | undefined,
  agentSteps: Array<{ reasoning?: string }> | undefined,
): GenerationInsight {
  const agentRequest = asRecord(invocationRequest?.agentRequest);
  const output = asRecord(agentRequest?.reengagementOutput);
  const reply = asRecord(invocationResponse?.reply);
  const usage = asRecord(reply?.usage);

  const thinking = (agentSteps ?? [])
    .map((step) => step.reasoning?.trim())
    .filter((text): text is string => !!text)
    .join('\n\n');

  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const usageText =
    typeof inputTokens === 'number' && typeof outputTokens === 'number'
      ? `输入 ${inputTokens} / 输出 ${outputTokens} tokens`
      : undefined;

  return {
    reason: asString(output?.reason),
    thinking: thinking || undefined,
    modelId: asString(agentRequest?.modelId),
    fallbackModelIds: asStringArray(agentRequest?.fallbackModelIds),
    systemPrompt: asString(agentRequest?.system),
    isTemplate: asString(agentRequest?.type) === 'template',
    validationReason: asString(agentRequest?.validationReason),
    usageText,
  };
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

  // 主动回合流水：generated_text 之外的生成内幕（提示词/模型思考/用量）都在这一行里
  const {
    data: turnRecord,
    isLoading: turnLoading,
    isError: turnError,
  } = useMessageProcessingRecordDetail(detailBatchId);
  const insight = useMemo(() => {
    if (!turnRecord?.agentInvocation) return null;
    return extractGenerationInsight(
      asRecord(turnRecord.agentInvocation.request),
      asRecord(turnRecord.agentInvocation.response),
      turnRecord.agentSteps,
    );
  }, [turnRecord]);

  const { data: sessionRecords, isLoading: sessionRecordsLoading } = useReengagementRecords({
    sessionId: record?.session_id ?? undefined,
    limit: 50,
    enabled: !!record?.session_id,
  });
  const sameSessionRecords = useMemo(
    () =>
      sortRecordsByCreatedAt(sessionRecords ?? []).filter(
        (item) => item.status !== 'superseded' || item.touch_key === record?.touch_key,
      ),
    [record?.touch_key, sessionRecords],
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
      {
        label: '候选人',
        value: record.candidate_name || record.user_id || record.session_id || '-',
      },
      { label: '接管账号', value: record.manager_name || record.bot_im_id || '-' },
      { label: '场景', value: scenarioLabels[record.scenario_code] ?? record.scenario_code ?? '-' },
      { label: '当前结论', value: getReadableStatus(record).title },
      { label: '原因', value: formatReason(record.decision_reason) },
    ];
  }, [record, scenarioLabels]);

  const technicalFacts = useMemo<InfoFact[]>(() => {
    if (!record) return [];
    return [
      { label: 'Touch Key', value: record.touch_key, mono: true },
      { label: 'Session', value: record.session_id || '-', mono: true },
      { label: 'User', value: record.user_id || '-', mono: true },
      { label: 'Corp', value: record.corp_id || '-', mono: true },
      { label: 'Outcome', value: record.outcome_kind || '-' },
      { label: 'Reserve', value: record.reserve_result || '-' },
      { label: '主动回合 Batch', value: detailBatchId || '-', mono: true },
    ];
  }, [detailBatchId, record]);

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

  const summary = record ? getReadableStatus(record) : null;
  const generatedText = record?.generated_text?.trim() || null;
  const messageTone: SummaryInfo['tone'] =
    record?.status === 'sent' ? 'success' : record?.status === 'shadow' ? 'warning' : 'muted';

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
            <h3 className={styles.headerTitle}>
              复聊详情 · {scenarioLabels[record.scenario_code] ?? record.scenario_code}
            </h3>
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
            {/* ① 复聊消息 —— 这条任务的最终产物，是详情页的主角 */}
            {generatedText ? (
              <div className={`${styles.messageCard} ${styles[`message_${messageTone}`]}`}>
                <div className={styles.messageHead}>
                  <MessageSquareText aria-hidden="true" size={15} />
                  <span className={styles.messageHeadTitle}>
                    {record.status === 'sent' ? '已发送的复聊消息' : '生成的复聊消息'}
                  </span>
                  {record.status === 'sent' && record.sent_at ? (
                    <span className={styles.messageChipSuccess}>
                      {formatDateTime(record.sent_at)} 已发出
                    </span>
                  ) : (
                    <span className={styles.messageChipMuted}>
                      未投递 · {formatReason(record.decision_reason)}
                    </span>
                  )}
                </div>
                <div className={styles.messageBubble}>{generatedText}</div>
              </div>
            ) : (
              summary && (
                <div className={`${styles.summaryCard} ${styles[`summary_${summary.tone}`]}`}>
                  <div className={styles.summaryIcon}>
                    <SummaryIcon icon={summary.icon} />
                  </div>
                  <div className={styles.summaryBody}>
                    <div className={styles.summaryTitle}>{summary.title}</div>
                    <div className={styles.summaryText}>{summary.description}</div>
                  </div>
                </div>
              )
            )}

            {/* Error */}
            {record.error && (
              <div className={styles.errorBox}>
                <div className={styles.errorTitle}>错误信息</div>
                <div className={styles.errorText}>{record.error}</div>
              </div>
            )}

            {/* ② 模型是怎么想的 —— 生成依据 + 思考过程 */}
            {detailBatchId && (
              <div>
                <div className={styles.sectionTitle}>
                  <Brain aria-hidden="true" size={14} />
                  模型是怎么想的
                  {insight?.modelId && (
                    <span className={styles.modelChip} title={insight.fallbackModelIds?.join(', ')}>
                      {insight.modelId}
                    </span>
                  )}
                  {insight?.usageText && (
                    <span className={styles.sectionNote}>{insight.usageText}</span>
                  )}
                </div>
                {turnLoading ? (
                  <div className={styles.emptyText}>加载生成轨迹中...</div>
                ) : turnError ? (
                  <div className={styles.emptyText}>
                    生成轨迹加载失败，请稍后重试或查看消息处理流水
                  </div>
                ) : !insight ? (
                  <div className={styles.emptyText}>
                    没有找到这次主动回合的生成轨迹（流水可能已过保留期）
                  </div>
                ) : insight.isTemplate ? (
                  <div className={styles.insightCard}>
                    <div className={styles.insightRow}>
                      <span className={styles.insightLabel}>生成方式</span>
                      <span className={styles.insightText}>
                        确定性模板拼接（事实齐全场景不调用大模型，时间地点直接来自报名记录）
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className={styles.insightCard}>
                    {insight.reason && (
                      <div className={styles.insightRow}>
                        <span className={styles.insightLabel}>生成依据</span>
                        <span className={styles.insightText}>{insight.reason}</span>
                      </div>
                    )}
                    {insight.thinking && (
                      <div className={styles.insightRow}>
                        <span className={styles.insightLabel}>思考过程</span>
                        <span className={`${styles.insightText} ${styles.insightThinking}`}>
                          {insight.thinking}
                        </span>
                      </div>
                    )}
                    {insight.validationReason && (
                      <div className={styles.insightRow}>
                        <span className={styles.insightLabel}>拦截原因</span>
                        <span className={styles.insightText}>
                          {formatReason(insight.validationReason)}
                        </span>
                      </div>
                    )}
                    {!insight.reason && !insight.thinking && !insight.validationReason && (
                      <div className={styles.insightRow}>
                        <span className={styles.insightText}>
                          这轮生成没有留下结构化的思考记录（老版本生成链路），完整请求可看下方提示词或消息处理流水。
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ③ 最终提示词 —— 实际发给模型的完整 system prompt */}
            {detailBatchId && insight?.systemPrompt && (
              <div>
                <div className={styles.sectionTitle}>
                  <FileText aria-hidden="true" size={14} />
                  最终提示词
                  <span className={styles.sectionNote}>实际发给模型的完整 system prompt</span>
                </div>
                <details className={styles.promptPanel} open>
                  <summary>
                    展开 / 收起全文（{insight.systemPrompt.length.toLocaleString()} 字）
                  </summary>
                  <pre className={styles.promptText}>{insight.systemPrompt}</pre>
                </details>
              </div>
            )}

            {/* ④ 最近聊天记录（默认折叠，避免淹没生成内幕） */}
            <details className={styles.collapsibleSection}>
              <summary className={styles.collapsibleSummary}>
                最近聊天记录
                <span className={styles.sectionNote}>
                  {chatLoading ? '加载中...' : `近 ${recentMessages.length} 条`}
                </span>
              </summary>
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
            </details>

            {/* ⑤ 这次任务流转 */}
            <details className={styles.collapsibleSection}>
              <summary className={styles.collapsibleSummary}>
                这次任务流转
                <span className={styles.sectionNote}>{events.length} 步</span>
              </summary>
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
            </details>

            {/* ⑥ 这个候选人的其他复聊（默认折叠：多为停止条件流水，排障时才需要） */}
            <details className={styles.collapsibleSection}>
              <summary className={styles.collapsibleSummary}>
                这个候选人的其他复聊
                {!sessionRecordsLoading && (
                  <span className={styles.sectionNote}>共 {sameSessionRecords.length} 条</span>
                )}
              </summary>
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
                          <span className={styles.taskReason}>
                            原因：{formatReason(task.decision_reason)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </details>
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
            <div className={styles.sideTitle}>一眼看懂</div>
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
            <div className={styles.sideTitle}>关键时间</div>
            <div className={styles.factList}>
              {timeFacts.map((fact) => (
                <div key={fact.label} className={styles.factRow}>
                  <span className={styles.factLabel}>{fact.label}</span>
                  <span className={styles.factValue}>{fact.value}</span>
                </div>
              ))}
            </div>

            <details className={styles.technicalPanel}>
              <summary>技术字段</summary>
              <div className={styles.factList}>
                {technicalFacts.map((fact) => (
                  <div key={fact.label} className={styles.factRow}>
                    <span className={styles.factLabel}>{fact.label}</span>
                    <span className={`${styles.factValue} ${fact.mono ? styles.monoValue : ''}`}>
                      {fact.value}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
