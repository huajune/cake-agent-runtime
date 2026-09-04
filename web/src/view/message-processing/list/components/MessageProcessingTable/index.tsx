import type { LucideIcon } from 'lucide-react';
import { ChevronRight, Inbox, ShieldAlert, ShieldOff, ShieldX, Zap } from 'lucide-react';
import { formatDateTime, formatLocaleNumber } from '@/utils/format';
import { guardrailReasonLabel, guardrailRuleListLabel } from '@/components/GuardrailTrace/labels';
import type { MessageRecord } from '@/api/types/chat.types';
import styles from './index.module.scss';

const SUPERSEDED_SUCCESS_MARKER = '补处理成功';
const SKELETON_ROWS = 8;

type StatusTone = 'success' | 'danger' | 'warning' | 'info';
type GuardrailTone = 'blocked' | 'repaired' | 'intercepted';

interface TableColumn {
  label: string;
  align?: 'center' | 'right';
}

const COLUMNS: TableColumn[] = [
  { label: '接收时间' },
  { label: '会话主体' },
  { label: '托管 BOT' },
  { label: '输入摘要' },
  { label: '响应摘要' },
  { label: '下发分段', align: 'center' },
  { label: '总 Token', align: 'right' },
  { label: 'TTFT', align: 'right' },
  { label: 'E2E 时延', align: 'right' },
  { label: '处理状态' },
];

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  success: styles.dotSuccess,
  danger: styles.dotDanger,
  warning: styles.dotWarning,
  info: styles.dotInfo,
};

const GUARDRAIL_FLAG_CLASS: Record<GuardrailTone, string> = {
  blocked: styles.flagDanger,
  repaired: styles.flagWarning,
  intercepted: styles.flagDanger,
};

const GUARDRAIL_FLAG_ICON: Record<GuardrailTone, LucideIcon> = {
  blocked: ShieldX,
  repaired: ShieldAlert,
  intercepted: ShieldOff,
};

function isSupersededTimeout(record: MessageRecord): boolean {
  return (
    record.status === 'timeout' &&
    typeof record.error === 'string' &&
    record.error.includes(SUPERSEDED_SUCCESS_MARKER)
  );
}

function getStatusLabel(record: MessageRecord): string {
  if (isSupersededTimeout(record)) return '已接管';

  switch (record.status) {
    case 'success':
      return '成功';
    case 'failure':
    case 'failed':
      return '失败';
    case 'timeout':
      return '超时';
    case 'processing':
      return '处理中';
    default:
      return String(record.status);
  }
}

function getStatusTone(record: MessageRecord): StatusTone {
  if (isSupersededTimeout(record)) return 'info';
  if (record.status === 'success') return 'success';
  if (record.status === 'failure' || record.status === 'failed' || record.status === 'timeout') {
    return 'danger';
  }
  return 'warning';
}

/** 守卫徽标：入站拦截 / 出站拦截 / 经受控修复后放行，其余（pass/observe）不加噪音。 */
function getGuardrailBadge(record: MessageRecord): { tone: GuardrailTone; title: string } | null {
  if (record.guardrailInput) {
    const label = record.guardrailInput.riskLabel || record.guardrailInput.riskType || '风险命中';
    return { tone: 'intercepted', title: `入站守卫拦截：${label}（本轮未跑 Agent）` };
  }
  const output = record.guardrailOutput;
  if (!output) return null;
  if (output.finalDecision === 'block') {
    const rules = output.steps.flatMap((s) => s.blockedRuleIds);
    const reason = output.reasonCode ? `（${guardrailReasonLabel(output.reasonCode)}）` : '';
    return {
      tone: 'blocked',
      title: `出站守卫拦截，未发送${reason}：${guardrailRuleListLabel(rules)}`,
    };
  }
  if (output.repaired) {
    const rules = output.steps[0]?.ruleIds ?? [];
    return {
      tone: 'repaired',
      title: `首版被守卫要求修复，修复后已发送：${guardrailRuleListLabel(rules)}`,
    };
  }
  return null;
}

function splitDateTime(value: string | number): { time: string; date: string; full: string } {
  const full = formatDateTime(value);
  const [date = '', time = ''] = full.split(' ');
  return { full, date: date.slice(5), time };
}

function TableHead() {
  return (
    <tr>
      {COLUMNS.map((column) => (
        <th
          key={column.label}
          className={
            column.align === 'center'
              ? styles.thCenter
              : column.align === 'right'
                ? styles.thRight
                : undefined
          }
        >
          {column.label}
        </th>
      ))}
    </tr>
  );
}

function SecondsCell({ ms }: { ms?: number | null }) {
  if (ms == null || !Number.isFinite(ms)) {
    return <span className={styles.muted}>–</span>;
  }
  return (
    <span className={styles.number}>
      {(ms / 1000).toFixed(2)}
      <span className={styles.unit}>秒</span>
    </span>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
        <tr key={rowIndex} className={styles.skeletonRow} aria-hidden="true">
          {COLUMNS.map((column) => (
            <td key={column.label}>
              <span className={styles.skeleton} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function EmptyState() {
  return (
    <tr>
      <td colSpan={COLUMNS.length} className={styles.stateCell}>
        <div className={styles.empty}>
          <span className={styles.emptyIcon}>
            <Inbox size={20} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <p className={styles.emptyTitle}>暂无处理记录</p>
          <p className={styles.emptyHint}>换个时间范围，或清空筛选条件再看看</p>
        </div>
      </td>
    </tr>
  );
}

interface MessageProcessingTableProps {
  data: MessageRecord[];
  loading?: boolean;
  onRowClick: (message: MessageRecord) => void;
  variant: 'realtime' | 'slowest';
  resolveBotLabel?: (message: MessageRecord) => string;
}

export default function MessageProcessingTable({
  data,
  loading,
  onRowClick,
  resolveBotLabel,
}: MessageProcessingTableProps) {
  return (
    <section className={styles.card}>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <TableHead />
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows />
            ) : data.length === 0 ? (
              <EmptyState />
            ) : (
              data.map((record, index) => {
                const subject = record.userName || record.chatId || '-';
                const botLabel = resolveBotLabel?.(record) || record.managerName || '-';
                const statusTone = getStatusTone(record);
                const statusLabel = getStatusLabel(record);
                const statusTitle = isSupersededTimeout(record) ? record.error : statusLabel;
                const badge = getGuardrailBadge(record);
                const GuardrailIcon = badge ? GUARDRAIL_FLAG_ICON[badge.tone] : null;
                const { time, date, full } = splitDateTime(record.receivedAt);

                return (
                  <tr
                    key={record.messageId || index}
                    className={styles.row}
                    tabIndex={0}
                    onClick={() => onRowClick(record)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') onRowClick(record);
                    }}
                  >
                    <td>
                      <span className={styles.timeCell} title={full}>
                        <span className={styles.date}>{date}</span>
                        <span className={styles.time}>{time}</span>
                      </span>
                    </td>
                    <td>
                      <span className={styles.subject} title={subject}>
                        {subject}
                      </span>
                    </td>
                    <td>
                      <span className={styles.bot} title={botLabel}>
                        {botLabel}
                      </span>
                    </td>
                    <td className={styles.previewCell}>
                      <span className={styles.preview} title={record.messagePreview}>
                        {record.messagePreview || '–'}
                      </span>
                    </td>
                    <td className={styles.previewCell}>
                      <span
                        className={`${styles.preview} ${styles.previewReply}`}
                        title={record.replyPreview}
                      >
                        {record.replyPreview || '–'}
                      </span>
                    </td>
                    <td className={styles.center}>
                      {record.replySegments == null ? (
                        <span className={styles.muted}>–</span>
                      ) : (
                        <span className={styles.number}>{record.replySegments}</span>
                      )}
                    </td>
                    <td className={styles.right}>
                      {record.tokenUsage == null ? (
                        <span className={styles.muted}>–</span>
                      ) : (
                        <span className={styles.number}>
                          {formatLocaleNumber(record.tokenUsage)}
                        </span>
                      )}
                    </td>
                    <td className={styles.right}>
                      <SecondsCell ms={record.ttftMs} />
                    </td>
                    <td className={styles.right}>
                      <SecondsCell ms={record.totalDuration} />
                    </td>
                    <td>
                      <div className={styles.statusWrap}>
                        <span className={styles.status} title={statusTitle}>
                          <span
                            className={`${styles.dot} ${STATUS_TONE_CLASS[statusTone]}`}
                            aria-hidden="true"
                          />
                          {statusLabel}
                        </span>
                        {record.isFallback && (
                          <span
                            className={`${styles.flag} ${
                              record.fallbackSuccess ? styles.flagWarning : styles.flagDanger
                            }`}
                            title={record.fallbackSuccess ? '模型降级成功' : '模型降级失败'}
                          >
                            <Zap size={13} strokeWidth={2} aria-hidden="true" />
                          </span>
                        )}
                        {badge && GuardrailIcon && (
                          <span
                            className={`${styles.flag} ${GUARDRAIL_FLAG_CLASS[badge.tone]}`}
                            title={badge.title}
                          >
                            <GuardrailIcon size={13} strokeWidth={2} aria-hidden="true" />
                          </span>
                        )}
                        <ChevronRight
                          size={14}
                          strokeWidth={2}
                          className={styles.rowChevron}
                          aria-hidden="true"
                        />
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
