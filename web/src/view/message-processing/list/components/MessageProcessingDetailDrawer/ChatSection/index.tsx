import { useDashboardAccess } from '@/hooks/useDashboardAccess';
import ModelCalls from './ModelCalls';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCapturedProcessingRequest } from '@/api/services/chat.service';
import type { MessageRecord } from '@/api/types/chat.types';
import MessagePartsAdapter from '@/view/agent-test/list/components/MessagePartsAdapter';
import {
  getAssistantRenderableMessage,
  getFallbackSummary,
  getHistoryMessages,
  getRawPayloadPanels,
  getToolCalls,
} from '../utils';
import { linkToolEvents } from '@/view/message-processing/tool-execution';
import ExecutionEventTimeline from '../ExecutionEventTimeline';
import ToolExecutionPanel from '../ToolExecutionPanel';
import styles from './index.module.scss';

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

const requestPanels = new Set([
  'request',
  'final-prompt',
  'debug-context',
  'transport-request',
  'normalized-request',
]);

function stringifyPayload(data: unknown): string {
  // 纯文本面板（如"最终提示词"）直接原文展示，不走 JSON.stringify——
  // 否则长文本被转义成带 \n 的单行字符串没法读。
  if (typeof data === 'string') return data;

  try {
    const serialized = JSON.stringify(data, null, 2);
    if (serialized !== undefined) return serialized;
  } catch {
    // 某些处理中记录可能包含暂时不可序列化的片段，降级为字符串避免整页崩溃。
  }

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

export default function ChatSection({ message }: ChatSectionProps) {
  const [activePayloadKey, setActivePayloadKey] = useState<string>('response');
  const toolCalls = useMemo(() => withFallback(() => getToolCalls(message), []), [message]);
  const linkedEvents = useMemo(
    () => linkToolEvents(message.messageId, toolCalls, message.executionEvents ?? []),
    [message, toolCalls],
  );
  const renderableMessage = useMemo(
    () => withFallback(() => getAssistantRenderableMessage(message), undefined),
    [message],
  );
  const historyMessages = useMemo(
    () =>
      withFallback(
        () => getHistoryMessages(message, { includeFallbackReply: !renderableMessage }),
        [],
      ),
    [message, renderableMessage],
  );
  const hasRequest = Boolean(message.messageId && message.agentInvocation?.request);
  const canInspectModelCalls =
    useDashboardAccess()?.centerId === null && Boolean(message.messageId);
  const showModelCalls = canInspectModelCalls && activePayloadKey === 'model-calls';
  const requestTab = requestPanels.has(activePayloadKey);
  const fullRequest = useQuery({
    queryKey: ['message-processing-record-detail', message.messageId, 'request'],
    queryFn: () => getCapturedProcessingRequest(message.messageId!),
    enabled: hasRequest && requestTab,
    staleTime: 60_000,
  });
  const rawPayloadPanels = useMemo(() => {
    const snapshot = message.agentInvocation;
    const request = hasRequest ? (fullRequest.data ?? snapshot?.request) : undefined;
    const panels = withFallback(
      () =>
        getRawPayloadPanels(
          {
            ...message,
            agentInvocation: snapshot ? { ...snapshot, request } : undefined,
          },
          toolCalls,
        ),
      [],
    );
    if (hasRequest && request?.agentRequest && !panels.some((p) => p.key === 'final-prompt')) {
      panels.splice(1, 0, {
        key: 'final-prompt',
        label: '最终提示词',
        description: '本次请求未捕获最终提示词',
        data: undefined,
      });
    }
    if (hasRequest && !fullRequest.data) {
      const description = fullRequest.isError
        ? '请求读取失败'
        : fullRequest.isSuccess
          ? '未留存完整请求'
          : '展开时读取完整请求';
      return panels.map((panel) =>
        requestPanels.has(panel.key) ? { ...panel, description, data: undefined } : panel,
      );
    }
    return panels;
  }, [
    message,
    hasRequest,
    fullRequest.data,
    fullRequest.isError,
    fullRequest.isSuccess,
    toolCalls,
  ]);
  const fallbackSummary = useMemo(
    () => withFallback(() => getFallbackSummary(message), undefined),
    [message],
  );
  const fallbackDeliveredSegments = fallbackSummary?.deliveredSegments;
  const hasFallbackDetails = Boolean(
    fallbackSummary?.message || fallbackSummary?.error || fallbackDeliveredSegments != null,
  );
  const activePanel =
    rawPayloadPanels.find((panel) => panel.key === activePayloadKey) ??
    rawPayloadPanels.find((panel) => panel.data !== undefined);
  const isProcessing = message.status === 'processing';

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
                    historyMessage.role === 'assistant'
                      ? styles.historyAssistant
                      : styles.historyUser
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
            <div className={styles.historyEmpty}>没有可展示的输入消息</div>
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
              <span className={styles.bubbleMeta}>{message.replySegments} 个下发分段</span>
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

        <ToolExecutionPanel
          toolCalls={toolCalls}
          events={message.executionEvents ?? []}
          links={linkedEvents}
        />

        {message.isFallback && hasFallbackDetails && (
          <div className={styles.fallbackBox}>
            <div className={styles.fallbackHeader}>
              <span>Fallback 回执</span>
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
              {fallbackDeliveredSegments != null ? (
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
              {typeof message.error === 'string' ? message.error : stringifyPayload(message.error)}
            </div>
          </div>
        )}
      </div>

      {(rawPayloadPanels.length > 0 || canInspectModelCalls) && (
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
                    !showModelCalls && activePanel?.key === panel.key
                      ? styles.rawTabButtonActive
                      : ''
                  }`}
                >
                  {panel.label}
                </button>
              ))}
              {canInspectModelCalls && (
                <button
                  type="button"
                  className={`${styles.rawTabButton} ${showModelCalls ? styles.rawTabButtonActive : ''}`}
                  onClick={() => setActivePayloadKey('model-calls')}
                >
                  模型调用原文
                </button>
              )}
            </div>

            {showModelCalls ? (
              <ModelCalls messageId={message.messageId!} />
            ) : activePanel ? (
              <div className={styles.payloadCard}>
                <div className={styles.payloadHeader}>
                  <div>
                    <div className={styles.payloadLabel}>{activePanel.label}</div>
                    <div className={styles.payloadDescription}>{activePanel.description}</div>
                  </div>
                  {activePanel.data !== undefined && (
                    <div className={styles.payloadMeta}>{getPayloadSummary(activePanel.data)}</div>
                  )}
                </div>
                <div className={styles.codeShell}>
                  {activePanel.data !== undefined ? (
                    <pre className={styles.codeBlock}>{stringifyPayload(activePanel.data)}</pre>
                  ) : fullRequest.isError ? (
                    <button
                      type="button"
                      className={styles.rawTabButton}
                      onClick={() => void fullRequest.refetch()}
                    >
                      重新读取
                    </button>
                  ) : (
                    <span>{fullRequest.isFetching ? '正在读取…' : '无可展示内容'}</span>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
      <ExecutionEventTimeline events={message.executionEvents} links={linkedEvents} />
    </>
  );
}
