import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { formatDateTime, formatJson } from '@/utils/format';
import { useReengagementRecordDetail } from '@/hooks/reengagement/useReengagementRecords';
import { useChatSessionMessages } from '@/hooks/chat/useChatSessions';
import type { ReengagementEvent } from '@/api/types/reengagement.types';
import StatusBadge from '../StatusBadge';
import styles from './index.module.scss';

/** 详情里只看触达前后的语境，最近 10 条足够 */
const RECENT_CHAT_LIMIT = 10;

interface ReengagementDetailDrawerProps {
  touchKey: string;
  onClose: () => void;
  /** code→displayName，由页面从场景注册表接口构建（与 /config 页同源） */
  scenarioLabels: Record<string, string>;
}

interface InfoFact {
  label: string;
  value: string;
  mono?: boolean;
}

function formatMaybeTime(value?: string | null): string {
  return value ? formatDateTime(value) : '-';
}

function sortEventsAsc(events: ReengagementEvent[]): ReengagementEvent[] {
  // 防御 events 数组里的 null 元素（record RPC 旧版本在无 event 写入时会落 [null]）
  return events.filter(Boolean).sort((a, b) => {
    const at = Date.parse(a.at);
    const bt = Date.parse(b.at);
    return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0);
  });
}

export default function ReengagementDetailDrawer({
  touchKey,
  onClose,
  scenarioLabels,
}: ReengagementDetailDrawerProps) {
  const navigate = useNavigate();
  const { data: record, isLoading } = useReengagementRecordDetail(touchKey);

  const events = useMemo(() => sortEventsAsc(record?.events || []), [record?.events]);

  // 最近 10 条聊天记录：还原触达前后的会话语境
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
      { label: 'Batch', value: record.batch_id || '-', mono: true },
    ];
  }, [record, scenarioLabels]);

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
          <div className={styles.loadingBody}>{isLoading ? '加载中...' : '未找到触达详情'}</div>
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

            {/* Generated text */}
            <div>
              <div className={styles.sectionTitle}>
                生成文案
                {record.shadow && <span className={styles.shadowNote}>本应发（未投递）</span>}
              </div>
              {record.generated_text ? (
                <div className={styles.generatedText}>{record.generated_text}</div>
              ) : (
                <div className={styles.emptyText}>未生成文案</div>
              )}
            </div>

            {/* Lifecycle timeline */}
            <div>
              <div className={styles.sectionTitle}>生命周期时间线</div>
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
                          <span className={styles.timelineEvent}>{event.event}</span>
                          <span className={styles.timelineTime}>{formatDateTime(event.at)}</span>
                        </div>
                        {event.detail && Object.keys(event.detail).length > 0 && (
                          <details className={styles.timelineDetail}>
                            <summary>detail</summary>
                            <pre>{formatJson(event.detail)}</pre>
                          </details>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

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
          </div>

          <div className={styles.rightCol}>
            {/* 该触达由哪个主动回合投递：跳消息处理流水详情 */}
            {record.batch_id && (
              <button
                type="button"
                className={styles.batchLink}
                onClick={() =>
                  navigate(`/message-processing?messageId=${encodeURIComponent(record.batch_id!)}`)
                }
                title={`Batch: ${record.batch_id}`}
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
