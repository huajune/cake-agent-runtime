import { useEffect, useMemo, useState } from 'react';
import type { MessageRecord } from '@/api/types/chat.types';
import MessagePartsAdapter from '@/view/agent-test/list/components/MessagePartsAdapter';
import styles from './index.module.scss';
import {
  getAssistantRenderableMessage,
  getFallbackSummary,
  getRawPayloadPanels,
  getToolCalls,
} from '../utils';

function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} 字符`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)}K`;
  return `${(bytes / 1000000).toFixed(1)}M`;
}

interface ChatSectionProps {
  message: MessageRecord;
}

function stringifyPayload(data: unknown): string {
  const serialized = JSON.stringify(data, null, 2);
  if (serialized !== undefined) return serialized;
  return String(data);
}

function getPayloadSummary(data: unknown): string {
  if (Array.isArray(data)) {
    return `${data.length} 项 · ${formatSize(stringifyPayload(data).length)}`;
  }
  if (data && typeof data === 'object') {
    return `${Object.keys(data as Record<string, unknown>).length} 个字段 · ${formatSize(
      stringifyPayload(data).length,
    )}`;
  }
  if (typeof data === 'string') {
    return `${formatSize(data.length)}`;
  }
  return typeof data;
}

export default function ChatSection({
  message,
}: ChatSectionProps) {
  const [activePayloadKey, setActivePayloadKey] = useState<string>('request');
  const toolCalls = useMemo(() => getToolCalls(message), [message]);
  const rawPayloadPanels = useMemo(() => getRawPayloadPanels(message), [message]);
  const fallbackSummary = useMemo(() => getFallbackSummary(message), [message]);
  const renderableMessage = useMemo(() => getAssistantRenderableMessage(message), [message]);
  const fallbackDeliveredSegments = fallbackSummary?.deliveredSegments;
  const activePanel =
    rawPayloadPanels.find((panel) => panel.key === activePayloadKey) ?? rawPayloadPanels[0];

  const fallbackStatusText = message.fallbackSuccess === true ? '成功' : '失败';

  useEffect(() => {
    if (!activePanel && rawPayloadPanels.length > 0) {
      setActivePayloadKey(rawPayloadPanels[0].key);
    }
  }, [activePanel, rawPayloadPanels]);

  return (
    <>
      <div>
        <h4 className={styles.sectionTitle}>Agent 响应</h4>

        <div className={styles.responseCard}>
          <div className={styles.responseHeader}>
            <span className={`${styles.roleTag} ${styles.agentTag}`}>AGENT</span>
            {toolCalls.length > 0 && (
              <span className={styles.bubbleMeta}>{toolCalls.length} 个工具调用</span>
            )}
            {message.replySegments && (
              <span className={styles.bubbleMeta}>
                {message.replySegments} 个下发分段
              </span>
            )}
          </div>
          <div className={`${styles.responseBody} ${styles.agentRenderer}`}>
            {renderableMessage ? (
              <MessagePartsAdapter
                message={renderableMessage}
                expandToolsByDefault={false}
                expandReasoningByDefault={false}
              />
            ) : (
              <div className={styles.emptyResponse}>暂无可渲染的响应内容</div>
            )}
          </div>
        </div>

        {message.isFallback && (
          <div className={styles.fallbackBox}>
            <div className={styles.fallbackHeader}>
              <span>Fallback 回执</span>
              <span
                className={`${styles.fallbackBadge} ${
                  message.fallbackSuccess ? styles.success : styles.failed
                }`}
              >
                {fallbackStatusText}
              </span>
            </div>
            <div className={styles.fallbackContent}>
              {fallbackSummary?.message ? (
                <div>
                  <strong>Fallback 文案：</strong> {String(fallbackSummary.message)}
                </div>
              ) : null}
              {fallbackSummary?.error ? (
                <div>
                  <strong>Fallback 错误：</strong> {String(fallbackSummary.error)}
                </div>
              ) : null}
              {fallbackDeliveredSegments !== undefined ? (
                <div>
                  <strong>已下发分段：</strong> {String(fallbackDeliveredSegments)}
                </div>
              ) : null}
            </div>
          </div>
        )}

        {message.error && (
          <div className={styles.errorBox}>
            <div className={styles.errorHeader}>
              <span>异常详情</span>
            </div>
            <div className={styles.errorContent}>
              {typeof message.error === 'string'
                ? message.error
                : JSON.stringify(message.error, null, 2)}
            </div>
          </div>
        )}
      </div>

      {rawPayloadPanels.length > 0 && (
        <div className={styles.rawSection}>
          <h4 className={styles.rawTitle}>调试载荷</h4>
          <div className={styles.payloadShell}>
            <div className={styles.rawTabs}>
              {rawPayloadPanels.map((panel) => (
                <button
                  key={panel.key}
                  type="button"
                  onClick={() => setActivePayloadKey(panel.key)}
                  className={`${styles.rawTabButton} ${
                    activePanel?.key === panel.key ? styles.rawTabButtonActive : ''
                  }`}
                >
                  {panel.label}
                </button>
              ))}
            </div>

            {activePanel ? (
              <div className={styles.payloadCard}>
                <div className={styles.payloadHeader}>
                  <div>
                    <div className={styles.payloadLabel}>{activePanel.label}</div>
                    <div className={styles.payloadDescription}>{activePanel.description}</div>
                  </div>
                  <div className={styles.payloadMeta}>
                    {getPayloadSummary(activePanel.data)}
                  </div>
                </div>
                <div className={styles.codeShell}>
                  <pre className={styles.codeBlock}>{stringifyPayload(activePanel.data)}</pre>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
