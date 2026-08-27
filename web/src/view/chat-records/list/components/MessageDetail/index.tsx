import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatMessage, ChatSession } from '@/hooks/chat/useChatSessions';
import { useMessageProcessingRecords } from '@/hooks/chat/useMessageProcessingRecords';
import type { MessageRecord } from '@/api/types/chat.types';
import type { FeedbackSourceTrace } from '@/api/types/agent-test.types';
import { FeedbackButtons } from '@/view/agent-test/list/components/FeedbackButtons';
import { FeedbackModal } from '@/view/agent-test/list/components/FeedbackModal';
import { useFeedback } from '@/view/agent-test/list/hooks/useFeedback';
import { formatLocaleDate, formatLocaleDateTime } from '@/utils/format';
import { MessageBubbleContent } from './MessageBubbleContent';
import { getBubbleVariant } from './bubble-variant';
import styles from './index.module.scss';

// 格式化时间戳
function formatTime(timestamp: number): string {
  return formatLocaleDateTime(timestamp, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 格式化日期（用于分组）
function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return '今天';
  } else if (date.toDateString() === yesterday.toDateString()) {
    return '昨天';
  }
  return formatLocaleDate(date, { month: 'long', day: 'numeric' });
}

function isAssistantMessage(message: ChatMessage): boolean {
  if (typeof message.isSelf === 'boolean') {
    return message.isSelf;
  }
  return message.role === 'assistant';
}

function getMessageId(message: ChatMessage, fallbackIndex?: number): string | undefined {
  return (
    message.id ||
    message.messageId ||
    (fallbackIndex !== undefined
      ? `${message.chatId || 'chat'}-${message.timestamp}-${fallbackIndex}`
      : undefined)
  );
}

const PROCESSING_MATCH_WINDOW_MS = 5 * 60 * 1000;

function toTimestamp(value: string | number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function findNearestProcessingRecord(
  records: MessageRecord[],
  messageTimestamp: number,
): MessageRecord | undefined {
  let nearest: MessageRecord | undefined;
  let nearestDistance = PROCESSING_MATCH_WINDOW_MS + 1;

  for (const record of records) {
    if (!record.messageId) continue;
    const receivedAt = toTimestamp(record.receivedAt);
    if (receivedAt === undefined) continue;
    const distance = Math.abs(receivedAt - messageTimestamp);
    if (distance <= PROCESSING_MATCH_WINDOW_MS && distance < nearestDistance) {
      nearest = record;
      nearestDistance = distance;
    }
  }

  return nearest;
}

interface MessageDetailProps {
  selectedChatId: string | null;
  messages: ChatMessage[];
  currentSession?: ChatSession;
  isLoading: boolean;
}

export default function MessageDetail({
  selectedChatId,
  messages,
  currentSession,
  isLoading,
}: MessageDetailProps) {
  const navigate = useNavigate();
  const { data: processingRecords = [], isLoading: processingRecordsLoading } =
    useMessageProcessingRecords({
      chatId: selectedChatId ?? undefined,
      enabled: Boolean(selectedChatId),
    });
  const feedback = useFeedback({ source: 'chat_record' });
  const {
    addScreenshots,
    clearSuccess,
    closeModal,
    feedbackType,
    isOpen,
    isSubmitting,
    openModal,
    remark,
    priority,
    expectedBehavior,
    removeScreenshot,
    scenarioType,
    screenshots,
    setRemark,
    setPriority,
    setExpectedBehavior,
    setScenarioType,
    submit,
    submitError,
    successType,
  } = feedback;

  // 按日期分组消息
  const groupedMessages: { date: string; messages: ChatMessage[] }[] = [];
  let currentDate = '';
  messages.forEach((msg) => {
    const msgDate = formatDate(msg.timestamp);
    if (msgDate !== currentDate) {
      currentDate = msgDate;
      groupedMessages.push({ date: msgDate, messages: [] });
    }
    groupedMessages[groupedMessages.length - 1].messages.push(msg);
  });

  const chatHistoryPreview = useMemo(
    () =>
      messages
        .map((msg) => {
          const isAssistant = isAssistantMessage(msg);
          const displayName = isAssistant
            ? msg.managerName || currentSession?.managerName || '招募经理'
            : msg.candidateName || currentSession?.candidateName || '候选人';
          return `[${formatTime(msg.timestamp)} ${displayName}] ${msg.content}`;
        })
        .join('\n'),
    [currentSession?.candidateName, currentSession?.managerName, messages],
  );

  const lastUserMessageRecord = useMemo(
    () => [...messages].reverse().find((msg) => !isAssistantMessage(msg) && msg.content.trim()),
    [messages],
  );
  const lastUserMessage = lastUserMessageRecord?.content;
  const lastUserMessageId = lastUserMessageRecord ? getMessageId(lastUserMessageRecord) : undefined;
  const sourceTrace = useMemo<FeedbackSourceTrace | undefined>(() => {
    if (!selectedChatId) return undefined;
    const relatedMessageIds = messages
      .map((msg) => getMessageId(msg))
      .filter((id): id is string => Boolean(id));

    return {
      chatIds: [selectedChatId],
      anchorMessageIds: lastUserMessageId ? [lastUserMessageId] : undefined,
      relatedMessageIds,
      raw: {
        source: 'chat-record-detail',
        messageCount: messages.length,
        firstMessageAt: messages[0]?.timestamp,
        lastMessageAt: messages[messages.length - 1]?.timestamp,
      },
    };
  }, [lastUserMessageId, messages, selectedChatId]);

  const handleSubmitFeedback = useCallback(() => {
    void submit({
      chatHistory: chatHistoryPreview,
      userMessage: lastUserMessage,
      chatId: selectedChatId || undefined,
      messageId: lastUserMessageId,
      sourceTrace,
      candidateName: currentSession?.candidateName,
      managerName: currentSession?.managerName,
    });
  }, [
    chatHistoryPreview,
    currentSession?.candidateName,
    currentSession?.managerName,
    lastUserMessage,
    lastUserMessageId,
    selectedChatId,
    sourceTrace,
    submit,
  ]);

  useEffect(() => {
    clearSuccess();
  }, [clearSuccess, selectedChatId]);

  // 自动滚动：切换会话后首批消息渲染完直达底部；实时新消息到达时若已接近底部则平滑跟随
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingInitialScrollRef = useRef(false);
  const prevMessageCountRef = useRef(0);

  useEffect(() => {
    pendingInitialScrollRef.current = true;
    prevMessageCountRef.current = 0;
  }, [selectedChatId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || messages.length === 0) return;

    if (pendingInitialScrollRef.current) {
      pendingInitialScrollRef.current = false;
      container.scrollTop = container.scrollHeight;
    } else if (messages.length > prevMessageCountRef.current) {
      const distanceToBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      // 用户正在回看历史消息时不打扰
      if (distanceToBottom < 200) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  let content: React.ReactNode;

  if (!selectedChatId) {
    content = (
      <div className={styles.stateContainer}>
        <div className={styles.stateIcon}>💬</div>
        <div>选择一个会话查看消息</div>
      </div>
    );
  } else if (isLoading) {
    content = (
      <div className={styles.stateContainer}>
        <div className="loading-spinner"></div>
        加载消息中...
      </div>
    );
  } else if (messages.length === 0) {
    content = (
      <div className={styles.stateContainer}>
        <div className={styles.stateIcon}>📭</div>
        <div>该会话暂无消息</div>
      </div>
    );
  } else {
    content = (
      <div className={styles.messagesContainer} ref={messagesContainerRef}>
        {groupedMessages.map((group) => (
          <div key={group.date} className={styles.messageGroup}>
            <div className={styles.dateDivider}>
              <span className={styles.dateBadge}>{group.date}</span>
            </div>
            {group.messages.map((msg, index) => {
              const isAssistant = isAssistantMessage(msg);
              const processingRecord = !isAssistant
                ? findNearestProcessingRecord(processingRecords, msg.timestamp)
                : undefined;
              const messageKey = getMessageId(msg, index);
              const displayName = isAssistant
                ? msg.managerName || currentSession?.managerName || '招募经理'
                : msg.candidateName || currentSession?.candidateName || '候选人';
              const avatarChar = displayName.charAt(0).toUpperCase();
              const avatarUrl = !isAssistant ? msg.avatar || currentSession?.avatar : undefined;
              const variant = getBubbleVariant(msg.messageType);
              const bubbleClass = [
                styles.messageBubble,
                isAssistant ? styles.assistant : styles.user,
                variant === 'media' ? styles.mediaBubble : '',
                variant === 'card' ? styles.cardBubble : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <div
                  key={messageKey}
                  className={`${styles.messageRow} ${isAssistant ? styles.assistant : ''}`}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={displayName}
                      className={`${styles.avatar} ${styles.user}`}
                      onError={(e) => {
                        const target = e.target as HTMLImageElement;
                        target.style.display = 'none';
                        target.nextElementSibling?.removeAttribute('style');
                      }}
                    />
                  ) : null}
                  <div
                    className={`${styles.avatar} ${isAssistant ? styles.assistant : styles.user}`}
                    style={{ display: avatarUrl ? 'none' : 'flex' }}
                  >
                    {avatarChar}
                  </div>
                  <div className={styles.messageContent}>
                    <div className={`${styles.messageMeta} ${isAssistant ? styles.assistant : ''}`}>
                      <span className={styles.senderName}>{displayName}</span>
                      <span className={styles.messageTime}>{formatTime(msg.timestamp)}</span>
                      {!isAssistant && (
                        <button
                          type="button"
                          className={styles.processingLink}
                          disabled={processingRecordsLoading || !processingRecord?.messageId}
                          title={
                            processingRecord?.messageId
                              ? `打开流水 ${processingRecord.messageId}`
                              : '该消息前后 5 分钟内未匹配到处理流水'
                          }
                          onClick={() => {
                            if (!processingRecord?.messageId) return;
                            navigate(
                              `/message-processing?messageId=${encodeURIComponent(
                                processingRecord.messageId,
                              )}`,
                            );
                          }}
                        >
                          查看处理详情
                        </button>
                      )}
                    </div>
                    <div className={bubbleClass}>
                      <MessageBubbleContent
                        messageType={msg.messageType}
                        content={msg.content}
                        payload={msg.payload}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {content}
      {selectedChatId && messages.length > 0 && (
        <div className={styles.actionBar}>
          <div className={styles.feedbackGroup}>
            <FeedbackButtons
              successType={successType}
              disabled={isLoading || !chatHistoryPreview.trim()}
              onGoodCase={() => openModal('goodcase')}
              onBadCase={() => openModal('badcase')}
            />
          </div>
        </div>
      )}
      <FeedbackModal
        isOpen={isOpen}
        feedbackType={feedbackType}
        scenarioType={scenarioType}
        remark={remark}
        priority={priority}
        expectedBehavior={expectedBehavior}
        isSubmitting={isSubmitting}
        chatHistoryPreview={chatHistoryPreview}
        submitError={submitError}
        screenshots={screenshots}
        onAddScreenshots={addScreenshots}
        onRemoveScreenshot={removeScreenshot}
        onClose={closeModal}
        onScenarioTypeChange={setScenarioType}
        onRemarkChange={setRemark}
        onPriorityChange={setPriority}
        onExpectedBehaviorChange={setExpectedBehavior}
        onSubmit={handleSubmitFeedback}
      />
    </div>
  );
}
