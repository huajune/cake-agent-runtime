import { formatDateTime } from '@/utils/format';
import type { ReengagementTouchRecord } from '@/api/types/reengagement.types';
import { getScenarioLabel, getStatusMeta } from '../../constants';
import StatusBadge from '../StatusBadge';
import styles from './index.module.scss';

function truncateSessionId(sessionId: string, maxLength = 18): string {
  if (!sessionId) return '-';
  if (sessionId.length <= maxLength) return sessionId;
  return `${sessionId.slice(0, maxLength)}…`;
}

interface ReengagementTableProps {
  data: ReengagementTouchRecord[];
  loading?: boolean;
  onRowClick: (record: ReengagementTouchRecord) => void;
}

export default function ReengagementTable({ data, loading, onRowClick }: ReengagementTableProps) {
  const tableHeaders = (
    <tr>
      <th>创建时间</th>
      <th>会话</th>
      <th>场景</th>
      <th>状态</th>
      <th>决策原因</th>
      <th>计划触发时间</th>
      <th>投递时间</th>
      <th>Shadow</th>
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
                <td colSpan={8} className={styles.loading}>
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
                <td colSpan={8} className={styles.loading}>
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
                          stroke="url(#reengagementEmptyGrad)"
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
                          <linearGradient id="reengagementEmptyGrad" x1="0" y1="0" x2="72" y2="72">
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
              const statusMeta = getStatusMeta(record.status);
              const statusTitle = record.error
                ? `${statusMeta.label}：${record.error}`
                : record.decision_reason
                  ? `${statusMeta.label}：${record.decision_reason}`
                  : statusMeta.label;

              return (
                <tr
                  key={record.touch_key || i}
                  onClick={() => onRowClick(record)}
                  className={styles.clickableRow}
                >
                  <td>{record.created_at ? formatDateTime(record.created_at) : '-'}</td>
                  <td className={styles.cellMono} title={record.session_id}>
                    {truncateSessionId(record.session_id)}
                  </td>
                  <td className={styles.scenarioCell} title={record.scenario_code}>
                    {getScenarioLabel(record.scenario_code)}
                  </td>
                  <td>
                    <StatusBadge status={record.status} title={statusTitle} />
                  </td>
                  <td className={styles.cellTruncateLarge} title={record.decision_reason || ''}>
                    {record.decision_reason || '-'}
                  </td>
                  <td>{record.fire_at ? formatDateTime(record.fire_at) : '-'}</td>
                  <td>{record.sent_at ? formatDateTime(record.sent_at) : '-'}</td>
                  <td className={styles.cellCenter}>
                    {record.shadow ? (
                      <span className={styles.shadowFlag} title="Shadow：生成了文案但未投递">
                        Shadow
                      </span>
                    ) : (
                      '-'
                    )}
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
