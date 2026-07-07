import { Clock, BellRing, AlertTriangle } from 'lucide-react';
import { formatDateTime, formatRelativeTime, truncateSessionId } from '@/utils/format';
import type { ReengagementCandidateSummary } from '@/api/types/reengagement.types';
import { AVATAR_GRADIENTS, getAvatarStyle, getUserInitial } from '@/utils/avatar';
import { getStatusMeta } from '../../constants';
import styles from './index.module.scss';

/** 未来时间的相对表述（fire_at 倒计时）；已过期/无效返回 null */
function formatCountdown(fireAt: string): string | null {
  const target = Date.parse(fireAt);
  if (!Number.isFinite(target)) return null;
  const diffMin = Math.floor((target - Date.now()) / 60000);
  if (diffMin < 0) return null;
  if (diffMin < 1) return '即将触发';
  if (diffMin < 60) return `${diffMin} 分钟后`;
  const hours = Math.floor(diffMin / 60);
  const minutes = diffMin % 60;
  if (hours < 24) {
    return minutes > 0 ? `${hours} 小时 ${minutes} 分钟后` : `${hours} 小时后`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days} 天 ${remainingHours} 小时后` : `${days} 天后`;
}

/** 行点击的默认目标：优先待发任务，否则最近更新的场景触达 */
function primaryTouchKey(candidate: ReengagementCandidateSummary): string | null {
  if (candidate.nextTouch) return candidate.nextTouch.touchKey;
  const latest = [...candidate.scenarios].sort(
    (a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''),
  )[0];
  return latest?.touchKey ?? null;
}

interface CandidateTableProps {
  data: ReengagementCandidateSummary[];
  loading?: boolean;
  /** 接口失败时置位：错误必须与"真实无数据"在 UI 上可区分，否则故障被空态文案掩盖 */
  error?: boolean;
  /** code→displayName，由页面从场景注册表接口构建（与流水视图同源） */
  scenarioLabels: Record<string, string>;
  /** 点场景芯片打开对应触达的详情抽屉 */
  onTouchClick: (touchKey: string) => void;
}

/**
 * 候选人视角：一行一个候选人（session），左侧突出"下一次会发什么"，
 * 右侧是各场景当前态芯片（每场景最新一次触达，点开看全轨迹）。
 * 整行可点：进入该候选人最相关的触达（待发任务优先）。
 */
export default function CandidateTable({
  data,
  loading,
  error,
  scenarioLabels,
  onTouchClick,
}: CandidateTableProps) {
  const tableHeaders = (
    <tr>
      <th>候选人</th>
      <th>接管账号</th>
      <th>下一次触达</th>
      <th>各场景当前态</th>
      <th className={styles.thRight}>最近活动</th>
    </tr>
  );

  if (loading || error || data.length === 0) {
    return (
      <section className={styles.section}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>{tableHeaders}</thead>
            <tbody>
              <tr>
                <td colSpan={5} className={styles.loading}>
                  {loading ? (
                    <div className={styles.emptyStateContainer}>
                      <div className={styles.spinner} />
                      <p>加载中...</p>
                    </div>
                  ) : error ? (
                    <div className={styles.emptyStateContainer}>
                      <div className={styles.emptyIconHalo}>
                        <AlertTriangle className={styles.emptyIcon} aria-hidden="true" />
                      </div>
                      <p>候选人数据加载失败</p>
                      <span className={styles.emptyHint}>请刷新页面重试，持续失败请联系研发排查</span>
                    </div>
                  ) : (
                    <div className={styles.emptyStateContainer}>
                      <div className={styles.emptyIconHalo}>
                        <BellRing className={styles.emptyIcon} aria-hidden="true" />
                      </div>
                      <p>暂无候选人触达数据</p>
                      <span className={styles.emptyHint}>产生二次触发任务后，候选人会即刻出现在这里</span>
                    </div>
                  )}
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
            {data.map((candidate, index) => {
              const rowTouchKey = primaryTouchKey(candidate);
              const nextTouchCountdown = candidate.nextTouch
                ? formatCountdown(candidate.nextTouch.fireAt)
                : null;
              return (
                <tr
                  key={candidate.sessionId}
                  className={styles.clickableRow}
                  style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
                  onClick={() => rowTouchKey && onTouchClick(rowTouchKey)}
                >
                  <td title={candidate.sessionId}>
                    <div className={styles.candidateCell}>
                      {(() => {
                        const displayName =
                          candidate.candidateName ||
                          candidate.userId ||
                          truncateSessionId(candidate.sessionId);
                        return (
                          <>
                            <div
                              className={styles.avatar}
                              style={getAvatarStyle(
                                candidate.candidateName || candidate.userId || candidate.sessionId,
                                AVATAR_GRADIENTS,
                              )}
                            >
                              {getUserInitial(candidate.candidateName || candidate.userId || undefined)}
                            </div>
                            <span className={styles.candidateUser}>{displayName}</span>
                          </>
                        );
                      })()}
                    </div>
                  </td>
                  <td
                    className={styles.botCell}
                    title={
                      candidate.managerName || candidate.botImId
                        ? `接管账号${candidate.botImId ? ` (${candidate.botImId})` : ''}`
                        : undefined
                    }
                  >
                    {candidate.managerName || candidate.botImId || '—'}
                  </td>
                  <td>
                    {candidate.nextTouch ? (
                      <button
                        type="button"
                        className={styles.nextTouch}
                        onClick={(e) => {
                          e.stopPropagation();
                          onTouchClick(candidate.nextTouch!.touchKey);
                        }}
                        title={`计划触发：${formatDateTime(candidate.nextTouch.fireAt)}，点击查看完整轨迹`}
                      >
                        <Clock aria-hidden="true" size={13} className={styles.nextTouchIcon} />
                        <span className={styles.nextTouchScenario}>
                          {scenarioLabels[candidate.nextTouch.scenarioCode] ??
                            candidate.nextTouch.scenarioCode}
                        </span>
                        {nextTouchCountdown && (
                          <span className={styles.nextTouchCountdown}>{nextTouchCountdown}</span>
                        )}
                        <span className={styles.nextTouchTime}>
                          {formatDateTime(candidate.nextTouch.fireAt)}
                        </span>
                      </button>
                    ) : (
                      <span className={styles.noPending}>—</span>
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
                            onClick={(e) => {
                              e.stopPropagation();
                              onTouchClick(scenario.touchKey);
                            }}
                            title={title}
                          >
                            <span className={styles.chipDot} aria-hidden="true" />
                            <span className={styles.chipScenario}>
                              {scenarioLabels[scenario.scenarioCode] ?? scenario.scenarioCode}
                            </span>
                            <span className={styles.chipStatus}>{meta.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td className={styles.cellRight} title={formatDateTime(candidate.latestAt)}>
                    <div className={styles.latestCell}>
                      <span className={styles.latestRelative}>
                        {formatRelativeTime(candidate.latestAt)}
                      </span>
                      <span className={styles.latestAbsolute}>
                        {formatDateTime(candidate.latestAt)}
                      </span>
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
