import { formatDateTime, formatDuration } from '@/utils/format';
import type { MessageRecord } from '@/api/types/chat.types';
import styles from './index.module.scss';

interface LogsTableProps {
  data: MessageRecord[];
  loading?: boolean;
  onRowClick: (message: MessageRecord) => void;
  variant: 'realtime' | 'slowest';
}

export default function LogsTable({ data, loading, onRowClick, variant }: LogsTableProps) {
  const tableHeaders = (
    <tr>
      <th>时间</th>
      <th>用户</th>
      <th>用户消息</th>
      <th>回复预览</th>
      <th>回复条数</th>
      <th>Token</th>
      <th>{variant === 'slowest' ? '首条响应 ↓' : '首条响应'}</th>
      <th>总耗时</th>
      <th>状态</th>
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
                <td colSpan={9} className={styles.loading}>
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
                <td colSpan={9} className={styles.loading}>
                  <div className={styles.emptyStateContainer}>
                    <div className={styles.emptyIconWrapper}>
                      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className={styles.emptyIcon}>
                        <circle cx="32" cy="32" r="31" stroke="#E6EFF5" strokeWidth="2" fill="none" />
                        <path d="M22 20H42C44.2 20 46 21.8 46 24V44H18V24C18 21.8 19.8 20 22 20Z" fill="white" stroke="#A3AED0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M26 28H38" stroke="#D8E3F0" strokeWidth="2" strokeLinecap="round" />
                        <path d="M26 34H38" stroke="#D8E3F0" strokeWidth="2" strokeLinecap="round" />
                        <circle cx="42" cy="24" r="2.5" fill="#FF7596" />
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
            {data.map((record, i) => (
              <tr
                key={record.messageId || i}
                onClick={() => onRowClick(record)}
                className={styles.clickableRow}
              >
                <td>{formatDateTime(record.receivedAt)}</td>
                <td>{record.userName || record.chatId}</td>
                <td className={styles.cellTruncate}>
                  {record.messagePreview || '-'}
                </td>
                <td className={styles.cellTruncateLarge}>
                  {record.replyPreview || '-'}
                </td>
                <td className={styles.cellCenter}>{record.replySegments ?? '-'}</td>
                <td className={styles.cellMono}>
                  {record.tokenUsage?.toLocaleString() || '-'}
                </td>
                <td className={variant === 'slowest' ? styles.cellHighlight : undefined}>
                  {record.aiDuration !== undefined ? formatDuration(record.aiDuration) : '-'}
                </td>
                <td>{formatDuration(record.totalDuration)}</td>
                <td>
                  <div className={styles.statusCell}>
                    <span
                      className={`status-badge ${record.status === 'success'
                        ? 'success'
                        : record.status === 'failure' || record.status === 'failed'
                          ? 'danger'
                          : 'warning'
                        }`}
                    >
                      {record.status}
                    </span>
                    {record.isFallback && (
                      <span
                        title={record.fallbackSuccess ? '降级成功' : '降级失败'}
                        className={`${styles.fallbackIcon} ${record.fallbackSuccess ? styles.success : styles.failed}`}
                      >
                        ⚡
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
