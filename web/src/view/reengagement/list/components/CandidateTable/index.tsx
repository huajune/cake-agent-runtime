import { formatDateTime } from '@/utils/format';
import type { ReengagementCandidateSummary } from '@/api/types/reengagement.types';
import { getStatusMeta } from '../../constants';
import styles from './index.module.scss';

function truncateSessionId(sessionId: string, maxLength = 18): string {
  if (!sessionId) return '-';
  if (sessionId.length <= maxLength) return sessionId;
  return `${sessionId.slice(0, maxLength)}…`;
}

interface CandidateTableProps {
  data: ReengagementCandidateSummary[];
  loading?: boolean;
  /** code→displayName，由页面从场景注册表接口构建（与流水视图同源） */
  scenarioLabels: Record<string, string>;
  /** 点场景芯片打开对应触达的详情抽屉 */
  onTouchClick: (touchKey: string) => void;
}

/**
 * 候选人视角：一行一个候选人（session），左侧突出"下一次会发什么"，
 * 右侧是各场景当前态芯片（每场景最新一次触达，点开看全轨迹）。
 */
export default function CandidateTable({
  data,
  loading,
  scenarioLabels,
  onTouchClick,
}: CandidateTableProps) {
  const tableHeaders = (
    <tr>
      <th>候选人</th>
      <th>下一次触达</th>
      <th>各场景当前态</th>
      <th>最近活动</th>
    </tr>
  );

  if (loading || data.length === 0) {
    return (
      <section className={styles.section}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>{tableHeaders}</thead>
            <tbody>
              <tr>
                <td colSpan={4} className={styles.loading}>
                  {loading ? '加载中...' : '暂无候选人触达数据'}
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
            {data.map((candidate) => (
              <tr key={candidate.sessionId}>
                <td className={styles.cellMono} title={candidate.sessionId}>
                  {candidate.userId ? (
                    <div className={styles.candidateCell}>
                      <span className={styles.candidateUser}>{candidate.userId}</span>
                      <span className={styles.candidateSession}>
                        {truncateSessionId(candidate.sessionId)}
                      </span>
                    </div>
                  ) : (
                    truncateSessionId(candidate.sessionId)
                  )}
                </td>
                <td>
                  {candidate.nextTouch ? (
                    <button
                      type="button"
                      className={styles.nextTouch}
                      onClick={() => onTouchClick(candidate.nextTouch!.touchKey)}
                      title="点击查看该触达的完整轨迹"
                    >
                      <span className={styles.nextTouchScenario}>
                        {scenarioLabels[candidate.nextTouch.scenarioCode] ??
                          candidate.nextTouch.scenarioCode}
                      </span>
                      <span className={styles.nextTouchTime}>
                        {formatDateTime(candidate.nextTouch.fireAt)}
                      </span>
                    </button>
                  ) : (
                    <span className={styles.noPending}>无待发任务</span>
                  )}
                </td>
                <td>
                  <div className={styles.chipGroup}>
                    {candidate.scenarios.map((scenario) => {
                      const meta = getStatusMeta(scenario.status);
                      const title = [
                        `${scenarioLabels[scenario.scenarioCode] ?? scenario.scenarioCode}：${meta.label}`,
                        scenario.decisionReason ? `原因：${scenario.decisionReason}` : null,
                        scenario.fireAt ? `计划触发：${formatDateTime(scenario.fireAt)}` : null,
                        scenario.sentAt ? `投递：${formatDateTime(scenario.sentAt)}` : null,
                      ]
                        .filter(Boolean)
                        .join('\n');
                      return (
                        <button
                          key={scenario.touchKey}
                          type="button"
                          className={`${styles.chip} ${styles[`tone_${meta.tone}`] ?? ''}`}
                          onClick={() => onTouchClick(scenario.touchKey)}
                          title={title}
                        >
                          <span className={styles.chipScenario}>
                            {scenarioLabels[scenario.scenarioCode] ?? scenario.scenarioCode}
                          </span>
                          <span className={styles.chipStatus}>{meta.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </td>
                <td>{formatDateTime(candidate.latestAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
