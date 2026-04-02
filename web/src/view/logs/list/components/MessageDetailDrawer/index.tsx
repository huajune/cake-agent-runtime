import { useState } from 'react';
import { formatDateTime } from '@/utils/format';
import { useMessageProcessingRecordDetail } from '@/hooks/chat/useMessageRecords';
import HistorySection from './HistorySection';
import ChatSection from './ChatSection';
import TechnicalStats from './TechnicalStats';
import { getStatusLabel, getStatusTone } from './utils';

interface MessageDetailDrawerProps {
  messageId: string;
  onClose: () => void;
}

export default function MessageDetailDrawer({ messageId, onClose }: MessageDetailDrawerProps) {
  const [showRaw, setShowRaw] = useState(false);

  // 按需加载完整详情（包含 agentInvocation）
  const { data: message, isLoading } = useMessageProcessingRecordDetail(messageId);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // 加载中状态
  if (isLoading || !message) {
    return (
      <div className="drawer-overlay" onClick={handleOverlayClick}>
        <div className="drawer-content">
          <div className="modal-header" style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0, fontSize: '18px' }}>处理记录详情</h3>
            <button className="modal-close" onClick={onClose}>
              &times;
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--text-secondary)' }}>
            {isLoading ? '加载中...' : '未找到消息详情'}
          </div>
        </div>
      </div>
    );
  }

  const statusTone = getStatusTone(message.status);

  return (
    <div className="drawer-overlay" onClick={handleOverlayClick}>
      <div className="drawer-content">
        {/* Header */}
        <div className="modal-header" style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <h3 style={{ margin: 0, fontSize: '18px' }}>处理记录详情</h3>
            <span className={`status-badge ${statusTone}`}>
              {getStatusLabel(message.status)}
            </span>
            {message.isFallback && (
              <span className="status-badge warning">
                {message.fallbackSuccess ? 'Fallback 成功' : 'Fallback 失败'}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
            <span>接收时间 {formatDateTime(message.receivedAt)}</span>
            <span>会话主体 {message.userName || message.chatId}</span>
            {message.scenario ? <span>场景 {message.scenario}</span> : null}
            <button className="modal-close" onClick={onClose} style={{ marginLeft: '8px' }}>
              &times;
            </button>
          </div>
        </div>

        {/* Unified Content Body */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Left Column: Raw Data & Conversation (65%) */}
          <div style={{ flex: '1 1 65%', padding: '24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* History Messages */}
            <HistorySection message={message} />

            <ChatSection
              message={message}
              showRaw={showRaw}
              onToggleRaw={() => setShowRaw(!showRaw)}
            />
          </div>

          {/* Right Column: Technical Stats */}
          <div style={{ flex: '0 0 360px', background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border)', padding: '20px', overflowY: 'auto' }}>
            <TechnicalStats message={message} />
          </div>
        </div>
      </div>
    </div>
  );
}
