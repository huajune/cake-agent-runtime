import type { ChatMessage, ChatSession } from '@/hooks/chat/useChatSessions';
import styles from './index.module.scss';

// 格式化时间戳
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
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
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

// 格式化语音时长
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}"`;
}

function isSafeUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

// ==================== 富媒体消息渲染 ====================

function renderImageContent(payload: Record<string, unknown>) {
  const imageUrl = (payload.imageUrl || payload.url) as string | undefined;
  if (!imageUrl) return <span className={styles.mediaFallback}>[ 图片消息 ]</span>;

  return (
    <div className={styles.imageMessage}>
      <img
        src={imageUrl}
        alt="图片消息"
        className={styles.messageImage}
        onClick={() => isSafeUrl(imageUrl) && window.open(imageUrl, '_blank')}
      />
    </div>
  );
}

function renderVoiceContent(payload: Record<string, unknown>) {
  const duration = payload.duration as number | undefined;
  const text = payload.text as string | undefined;
  const voiceUrl = (payload.voiceUrl || payload.url) as string | undefined;

  return (
    <div className={styles.voiceMessage}>
      <div
        className={styles.voiceBar}
        onClick={() => voiceUrl && isSafeUrl(voiceUrl) && window.open(voiceUrl, '_blank')}
      >
        <span className={styles.voiceIcon}>🎤</span>
        <span className={styles.voiceDuration}>
          {duration ? formatDuration(duration) : '--'}
        </span>
      </div>
      {text && <div className={styles.voiceText}>{text}</div>}
    </div>
  );
}

function renderEmotionContent(payload: Record<string, unknown>) {
  const imageUrl = payload.imageUrl as string | undefined;
  if (!imageUrl) return <span className={styles.mediaFallback}>[ 表情 ]</span>;

  return (
    <div className={styles.emotionMessage}>
      <img src={imageUrl} alt="表情" className={styles.emotionImage} />
    </div>
  );
}

function renderLinkContent(payload: Record<string, unknown>) {
  const title = payload.title as string | undefined;
  const description = payload.description as string | undefined;
  const url = payload.url as string | undefined;
  const thumbnailUrl = payload.thumbnailUrl as string | undefined;

  return (
    <div
      className={styles.linkCard}
      onClick={() => url && isSafeUrl(url) && window.open(url, '_blank')}
    >
      {thumbnailUrl && (
        <img src={thumbnailUrl} alt="" className={styles.linkThumbnail} />
      )}
      <div className={styles.linkInfo}>
        <div className={styles.linkTitle}>{title || '链接'}</div>
        {description && (
          <div className={styles.linkDesc}>{description}</div>
        )}
      </div>
    </div>
  );
}

function renderFileContent(payload: Record<string, unknown>) {
  const name = payload.name as string | undefined;
  const fileUrl = payload.fileUrl as string | undefined;
  const size = payload.size as number | undefined;

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      className={styles.fileCard}
      onClick={() => fileUrl && isSafeUrl(fileUrl) && window.open(fileUrl, '_blank')}
    >
      <span className={styles.fileIcon}>📎</span>
      <div className={styles.fileInfo}>
        <div className={styles.fileName}>{name || '文件'}</div>
        {size && <div className={styles.fileSize}>{formatFileSize(size)}</div>}
      </div>
    </div>
  );
}

function renderMiniProgramContent(payload: Record<string, unknown>) {
  const title = payload.title as string | undefined;
  const description = payload.description as string | undefined;

  return (
    <div className={styles.miniProgramCard}>
      <div className={styles.miniProgramHeader}>
        <span>📱</span>
        <span>小程序</span>
      </div>
      <div className={styles.miniProgramBody}>
        <div className={styles.miniProgramTitle}>{title || '小程序'}</div>
        {description && (
          <div className={styles.miniProgramDesc}>{description}</div>
        )}
      </div>
    </div>
  );
}

function renderCallRecordContent(payload: Record<string, unknown>) {
  const text = (payload.text || payload.content) as string | undefined;
  return (
    <div className={styles.callRecord}>
      <span>📞</span>
      <span>{text || '通话记录'}</span>
    </div>
  );
}

/**
 * 根据 messageType 和 payload 渲染消息内容
 */
function renderMessageContent(msg: ChatMessage) {
  const { messageType, payload, content } = msg;

  // 有 payload 的富媒体消息
  if (payload && messageType) {
    switch (messageType) {
      case 'IMAGE':
        return renderImageContent(payload);
      case 'VOICE':
        return renderVoiceContent(payload);
      case 'EMOTION':
        return renderEmotionContent(payload);
      case 'LINK':
        return renderLinkContent(payload);
      case 'FILE':
        return renderFileContent(payload);
      case 'MINI_PROGRAM':
        return renderMiniProgramContent(payload);
      case 'VIDEO':
        return renderImageContent(payload); // 视频用缩略图展示
      case 'CALL_RECORD':
        return renderCallRecordContent(payload);
    }
  }

  // 无 payload 的非文本消息，显示类型标记
  if (messageType && messageType !== 'TEXT') {
    const labels: Record<string, string> = {
      IMAGE: '[ 图片消息 ]',
      VOICE: '[ 语音消息 ]',
      EMOTION: '[ 表情 ]',
      VIDEO: '[ 视频消息 ]',
      FILE: '[ 文件 ]',
      LINK: '[ 链接 ]',
      MINI_PROGRAM: '[ 小程序 ]',
      LOCATION: '[ 位置 ]',
      CONTACT_CARD: '[ 名片 ]',
      CALL_RECORD: '[ 通话记录 ]',
      MONEY: '[ 红包/转账 ]',
      REVOKE: '[ 已撤回 ]',
    };
    if (!content) {
      return (
        <span className={styles.mediaFallback}>
          {labels[messageType] || `[ ${messageType} ]`}
        </span>
      );
    }
  }

  // 纯文本
  return <>{content}</>;
}

// ==================== 主组件 ====================

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

  if (!selectedChatId) {
    return (
      <div className={styles.panel}>
        <div className={styles.stateContainer}>
          <div className={styles.stateIcon}>💬</div>
          <div>选择一个会话查看消息</div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.panel}>
        <div className={styles.stateContainer}>
          <div className="loading-spinner"></div>
          加载消息中...
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.stateContainer}>
          <div className={styles.stateIcon}>📭</div>
          <div>该会话暂无消息</div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.messagesContainer}>
        {groupedMessages.map((group) => (
          <div key={group.date} className={styles.messageGroup}>
            <div className={styles.dateDivider}>
              <span className={styles.dateBadge}>{group.date}</span>
            </div>
            {group.messages.map((msg) => {
              const isAssistant = msg.role === 'assistant';
              const displayName = isAssistant
                ? msg.managerName || currentSession?.managerName || '招募经理'
                : msg.candidateName || currentSession?.candidateName || '候选人';
              const avatarChar = displayName.charAt(0).toUpperCase();
              const avatarUrl = !isAssistant
                ? msg.avatar || currentSession?.avatar
                : undefined;

              return (
                <div
                  key={msg.id}
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
                    <div
                      className={`${styles.messageMeta} ${isAssistant ? styles.assistant : ''}`}
                    >
                      <span className={styles.senderName}>{displayName}</span>
                      <span className={styles.messageTime}>{formatTime(msg.timestamp)}</span>
                    </div>
                    <div
                      className={`${styles.messageBubble} ${isAssistant ? styles.assistant : styles.user}`}
                    >
                      {renderMessageContent(msg)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
