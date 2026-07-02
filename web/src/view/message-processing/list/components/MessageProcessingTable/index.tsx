import { formatDateTime, formatDuration } from '@/utils/format';
import type { MessageRecord } from '@/api/types/chat.types';
import styles from './index.module.scss';

const SUPERSEDED_SUCCESS_MARKER = '补处理成功';

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

function getStatusTone(record: MessageRecord): 'success' | 'danger' | 'warning' | 'info' {
  if (isSupersededTimeout(record)) return 'info';
  if (record.status === 'success') return 'success';
  if (record.status === 'failure' || record.status === 'failed' || record.status === 'timeout') {
    return 'danger';
  }
  return 'warning';
}

/** 守卫徽标：入站拦截 / 出站拦截 / 经受控修复后放行，其余（pass/observe）不加噪音。 */
function getGuardrailBadge(
  record: MessageRecord,
): { tone: 'blocked' | 'repaired' | 'intercepted'; title: string } | null {
  if (record.guardrailInput) {
    const label = record.guardrailInput.riskLabel || record.guardrailInput.riskType || '风险命中';
    return { tone: 'intercepted', title: `入站守卫拦截：${label}（本轮未跑 Agent）` };
  }
  const output = record.guardrailOutput;
  if (!output) return null;
  if (output.finalDecision === 'block') {
    const rules = output.steps.flatMap((s) => s.blockedRuleIds);
    const reason = output.reasonCode ? `（${output.reasonCode}）` : '';
    return {
      tone: 'blocked',
      title: `出站守卫拦截，未发送${reason}：${[...new Set(rules)].join('、') || '-'}`,
    };
  }
  if (output.repaired) {
    const rules = output.steps[0]?.ruleIds ?? [];
    return {
      tone: 'repaired',
      title: `首版被守卫要求修复（${output.steps[0]?.decision ?? '-'}），修复后已发送：${rules.join('、') || '-'}`,
    };
  }
  return null;
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
  const tableHeaders = (
    <tr>
      <th>接收时间</th>
      <th>会话主体</th>
      <th>托管 BOT</th>
      <th>输入摘要</th>
      <th>响应摘要</th>
      <th>下发分段</th>
      <th>总 Token</th>
      <th>TTFT</th>
      <th>E2E 时延</th>
      <th>处理状态</th>
    </tr>
  );

  if (loading) {
    return (
      <section className={styles.section}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>{tableHeaders}</thead>
            <tbody>
              <tr>
                <td colSpan={10} className={styles.loading}>
                  加载中...
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  if (data.length === 0) {
    return (
      <section className={styles.section}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>{tableHeaders}</thead>
            <tbody>
              <tr>
                <td colSpan={10} className={styles.loading}>
                  <div className={styles.emptyStateContainer}>
                    <div className={styles.emptyIconWrapper}>
                      <svg
                        width="72"
                        height="72"
                        viewBox="0 0 72 72"
                        fill="none"
                        className={styles.emptyIcon}
                      >
                        <circle
                          cx="36"
                          cy="36"
                          r="35"
                          stroke="url(#emptyGrad)"
                          strokeWidth="1.5"
                          fill="rgba(99,102,241,0.03)"
                        />
                        <path
                          d="M24 22H48C50.2 22 52 23.8 52 26V50H20V26C20 23.8 21.8 22 24 22Z"
                          fill="white"
                          stroke="#c7d2fe"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M28 30H44"
                          stroke="#e0e7ff"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                        <path
                          d="M28 36H40"
                          stroke="#e0e7ff"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                        <path
                          d="M28 42H36"
                          stroke="#e0e7ff"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                        <circle cx="48" cy="26" r="3" fill="#818cf8" opacity="0.6" />
                        <defs>
                          <linearGradient id="emptyGrad" x1="0" y1="0" x2="72" y2="72">
                            <stop offset="0%" stopColor="#c7d2fe" />
                            <stop offset="100%" stopColor="#e0e7ff" />
                          </linearGradient>
                        </defs>
                      </svg>
                    </div>
                    <p>暂无数据</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>{tableHeaders}</thead>
          <tbody>
            {data.map((record, i) => {
              const botLabel = resolveBotLabel?.(record) || record.managerName || '-';
              const statusTone = getStatusTone(record);
              const statusTitle = isSupersededTimeout(record)
                ? record.error
                : getStatusLabel(record);

              return (
                <tr
                  key={record.messageId || i}
                  onClick={() => onRowClick(record)}
                  className={styles.clickableRow}
                >
                  <td>{formatDateTime(record.receivedAt)}</td>
                  <td>{record.userName || record.chatId}</td>
                  <td className={styles.botCell} title={botLabel}>
                    {botLabel}
                  </td>
                  <td className={styles.cellTruncate}>{record.messagePreview || '-'}</td>
                  <td className={styles.cellTruncateLarge}>{record.replyPreview || '-'}</td>
                  <td className={styles.cellCenter}>{record.replySegments ?? '-'}</td>
                  <td className={styles.cellMono}>{record.tokenUsage?.toLocaleString() || '-'}</td>
                  <td className={styles.cellMono}>
                    {record.ttftMs !== undefined ? formatDuration(record.ttftMs) : '-'}
                  </td>
                  <td>{formatDuration(record.totalDuration)}</td>
                  <td>
                    <div className={styles.statusCell}>
                      <span
                        className={`status-badge ${statusTone}`}
                        title={statusTitle}
                      >
                        {getStatusLabel(record)}
                      </span>
                      {record.isFallback && (
                        <span
                          title={record.fallbackSuccess ? '降级成功' : '降级失败'}
                          className={`${styles.fallbackIcon} ${record.fallbackSuccess ? styles.success : styles.failed}`}
                        >
                          ⚡
                        </span>
                      )}
                      {(() => {
                        const badge = getGuardrailBadge(record);
                        if (!badge) return null;
                        return (
                          <span
                            title={badge.title}
                            className={`${styles.guardrailIcon} ${styles[badge.tone]}`}
                          >
                            🛡
                          </span>
                        );
                      })()}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
