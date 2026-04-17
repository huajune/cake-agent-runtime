import { useEffect, useMemo, useState } from 'react';
import type { MessageRecord } from '@/api/types/chat.types';
import MessagePartsAdapter from '@/view/agent-test/list/components/MessagePartsAdapter';
import styles from './index.module.scss';
import {
  getAssistantRenderableMessage,
  getFallbackSummary,
  getHistoryMessages,
  getRawPayloadPanels,
  getToolCalls,
} from '../utils';

function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} 字符`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)}K`;
  return `${(bytes / 1000000).toFixed(1)}M`;
}

function withFallback<T>(factory: () => T, fallback: T): T {
  try {
    return factory();
  } catch (error) {
    console.warn('[MessageProcessingDetailDrawer][ChatSection] payload render fallback', error);
    return fallback;
  }
}

interface ChatSectionProps {
  message: MessageRecord;
}

function stringifyPayload(data: unknown): string {
  try {
    const serialized = JSON.stringify(data, null, 2);
    if (serialized !== undefined) return serialized;
  } catch {
    // 某些处理中记录可能包含暂时不可序列化的片段，降级为字符串避免整页崩溃。
  }

  if (typeof data === 'string') return data;
  if (data === undefined) return 'undefined';
  if (data === null) return 'null';
  return String(data);
}

function getPayloadSummary(data: unknown): string {
  return withFallback(() => {
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
  }, '暂无法预览');
}

export default function ChatSection({
  message,
}: ChatSectionProps) {
  const [activePayloadKey, setActivePayloadKey] = useState<string>('request');
  const toolCalls = useMemo(() => withFallback(() => getToolCalls(message), []), [message]);
  const historyMessages = useMemo(() => withFallback(() => getHistoryMessages(message), []), [message]);
  const rawPayloadPanels = useMemo(
    () => withFallback(() => getRawPayloadPanels(message), []),
    [message],
  );
  const fallbackSummary = useMemo(
    () => withFallback(() => getFallbackSummary(message), undefined),
    [message],
  );
  const renderableMessage = useMemo(
    () => withFallback(() => getAssistantRenderableMessage(message), undefined),
    [message],
  );
  const fallbackDeliveredSegments = fallbackSummary?.deliveredSegments;
  const activePanel =
    rawPayloadPanels.find((panel) => panel.key === activePayloadKey) ?? rawPayloadPanels[0];
  const isProcessing = message.status === 'processing';

  const fallbackStatusText = message.fallbackSuccess === true ? '成功' : '失败';

  useEffect(() => {
    if (!activePanel && rawPayloadPanels.length > 0) {
      setActivePayloadKey(rawPayloadPanels[0].key);
    }
  }, [activePanel, rawPayloadPanels]);

  return (
    <>
      <div>
        <h4 className={styles.sectionTitle}>聊天记录</h4>

        <div className={styles.historyCard}>
          {historyMessages.length > 0 ? (
            <div className={styles.historyList}>
              {historyMessages.map((historyMessage, index) => (
                <div
                  key={`${historyMessage.role}-${index}`}
                  className={`${styles.historyItem} ${
                    historyMessage.role === 'assistant' ? styles.historyAssistant : styles.historyUser
                  }`}
                >
                  <span className={styles.historyRole}>
                    {historyMessage.role === 'assistant' ? 'Agent' : '用户'}
                  </span>
                  <div className={styles.historyContent}>{historyMessage.content}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.historyEmpty}>
              未从请求体提取到聊天记录，可在下方“请求体”查看原始 messages
            </div>
          )}
        </div>

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
              <div className={styles.emptyResponse}>
                {isProcessing ? '请求仍在处理中，尚未生成可渲染的响应内容' : '暂无可渲染的响应内容'}
              </div>
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
                : stringifyPayload(message.error)}
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
