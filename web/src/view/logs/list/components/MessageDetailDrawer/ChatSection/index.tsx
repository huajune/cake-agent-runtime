import { useMemo, useState } from 'react';
import { renderContentWithMediaTags as renderMediaTags } from '@/utils/media-tags';
import type { MessageRecord } from '@/api/types/chat.types';
import MessagePartsAdapter from '@/view/agent-test/list/components/MessagePartsAdapter';
import styles from './index.module.scss';
import {
  getAssistantRenderableMessage,
  getFallbackSummary,
  getRawPayloadPanels,
} from '../utils';

// 需要截断的大字段路径（仅截断 request 部分，response 完整展示）
const TRUNCATE_PATHS = [
  'request.context.configData',
  'request.systemPrompt',
];

// 截断阈值（字符数）
const TRUNCATE_THRESHOLD = 500;

/**
 * 递归处理对象，对大字段进行截断摘要
 */
function truncateLargeFields(
  obj: unknown,
  currentPath = '',
  depth = 0
): unknown {
  // 防止无限递归
  // if (depth > 10) return '[深度限制]';

  if (obj === null || obj === undefined) return obj;

  // 处理数组
  if (Array.isArray(obj)) {
    // 检查是否需要截断整个数组
    if (TRUNCATE_PATHS.includes(currentPath)) {
      const jsonStr = JSON.stringify(obj);
      if (jsonStr.length > TRUNCATE_THRESHOLD) {
        return `[数组: ${obj.length} 项, ${formatSize(jsonStr.length)}] (已省略)`;
      }
    }
    // 递归处理数组元素
    return obj.map((item, i) =>
      truncateLargeFields(item, `${currentPath}[${i}]`, depth + 1)
    );
  }

  // 处理对象
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = currentPath ? `${currentPath}.${key}` : key;

      // 检查是否需要截断
      if (TRUNCATE_PATHS.includes(fieldPath)) {
        const jsonStr = JSON.stringify(value);
        if (jsonStr.length > TRUNCATE_THRESHOLD) {
          if (Array.isArray(value)) {
            result[key] = `[数组: ${value.length} 项, ${formatSize(jsonStr.length)}] (已省略)`;
          } else if (typeof value === 'object' && value !== null) {
            const keys = Object.keys(value);
            result[key] = `[对象: ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '...' : ''}, ${formatSize(jsonStr.length)}] (已省略)`;
          } else if (typeof value === 'string') {
            result[key] = `${value.slice(0, 100)}... [${formatSize(jsonStr.length)}]`;
          } else {
            result[key] = value;
          }
          continue;
        }
      }

      // 递归处理子字段
      result[key] = truncateLargeFields(value, fieldPath, depth + 1);
    }
    return result;
  }

  // 处理长字符串
  if (typeof obj === 'string' && obj.length > 1000) {
    return `${obj.slice(0, 200)}... [共 ${obj.length} 字符]`;
  }

  return obj;
}

function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} 字符`;
  if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)}K`;
  return `${(bytes / 1000000).toFixed(1)}M`;
}

const renderContentWithMediaTags = (content: string) =>
  renderMediaTags(content, styles.mediaTag);

interface ChatSectionProps {
  message: MessageRecord;
  showRaw: boolean;
  onToggleRaw: () => void;
}

export default function ChatSection({
  message,
  showRaw,
  onToggleRaw,
}: ChatSectionProps) {
  const [activePayloadKey, setActivePayloadKey] = useState<string>('request');
  const truncatedRawData = useMemo(() => {
    if (!showRaw) return [];

    return getRawPayloadPanels(message).map((panel) => ({
      ...panel,
      data: panel.key === 'response' ? panel.data : truncateLargeFields(panel.data),
    }));
  }, [message, showRaw]);

  const fallbackSummary = useMemo(() => getFallbackSummary(message), [message]);
  const renderableMessage = useMemo(() => getAssistantRenderableMessage(message), [message]);
  const fallbackDeliveredSegments = fallbackSummary?.deliveredSegments;
  const activePanel =
    truncatedRawData.find((panel) => panel.key === activePayloadKey) ?? truncatedRawData[0];

  const fallbackStatusText = message.fallbackSuccess === true ? '成功' : '失败';

  return (
    <>
      <div>
        <h4 className={styles.sectionTitle}>本次交互</h4>

        <div className={`${styles.chatBubble} ${styles.user}`}>
          <div className={styles.bubbleHeader}>
            <span className={styles.bubbleTitle}>输入摘要</span>
          </div>
          <div className={styles.bubbleContent}>
            {message.messagePreview
              ? renderContentWithMediaTags(message.messagePreview)
              : '(无消息内容)'}
          </div>
        </div>

        <div className={`${styles.chatBubble} ${styles.agent}`}>
          <div className={styles.bubbleHeader}>
            <span className={styles.bubbleTitle}>响应正文</span>
            {message.replySegments && (
              <span className={styles.bubbleMeta}>
                {message.replySegments} 个下发分段
              </span>
            )}
          </div>
          <div className={`${styles.bubbleContent} ${styles.primary} ${styles.agentRenderer}`}>
            {renderableMessage ? (
              <MessagePartsAdapter message={renderableMessage} />
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

      <div className={styles.rawSection}>
        <div className={styles.rawHeader}>
          <div>
            <h4 className={styles.rawTitle}>调试载荷</h4>
            <div className={styles.rawSubtitle}>按阶段查看 request、response 与回执信息</div>
          </div>
          <button
            onClick={onToggleRaw}
            className={styles.toggleButton}
          >
            {showRaw ? '收起' : '展开'}
          </button>
        </div>

        {showRaw &&
          (truncatedRawData.length > 0 ? (
            <div className={styles.payloadShell}>
              <div className={styles.rawTabs}>
                {truncatedRawData.map((panel) => (
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
                  </div>
                  <pre className={styles.codeBlock}>
                    {JSON.stringify(activePanel.data, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : (
            <div className={styles.emptyResponse}>当前记录没有可展示的调试载荷</div>
          ))}
      </div>
    </>
  );
}
