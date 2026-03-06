import { useEffect, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import {
  Trash2,
  Check,
  AlertTriangle,
  Bot,
  Activity,
  Clock,
  Sparkles,
  X,
  Send,
  Radio,
  FileJson,
} from 'lucide-react';
import { TestChatResponse } from '@/services/agent-test';
import { MessagePartsAdapter } from '../MessagePartsAdapter';
import { useChatTest, useFeedback } from '../../hooks';
import { FeedbackModal } from '../FeedbackModal';
import { MetricsRow } from '../MetricsRow';
import { FeedbackButtons } from '../FeedbackButtons';
import { CandidateSelector } from '../CandidateSelector';
import { HISTORY_PLACEHOLDER } from '../../constants';
import RedPacketRain from '@/components/RedPacketRain';
import styles from './index.module.scss';

interface ChatTesterProps {
  onTestComplete?: (result: TestChatResponse) => void;
}

export default function ChatTester({ onTestComplete }: ChatTesterProps) {
  // 使用聊天测试 Hook
  const {
    historyText,
    historyStatus,
    currentInput,
    localError,
    result,
    elapsedMs,
    isLoading,
    isStreaming,
    latestAssistantMessage,
    setHistoryText,
    setCurrentInput,
    setLocalError,
    handleTest,
    handleCancel,
    handleClear: handleChatClear,
    messageInputRef,
    replyContentRef,
  } = useChatTest({ onTestComplete });

  // 使用反馈 Hook
  const feedback = useFeedback({
    onError: (error) => setLocalError(error),
  });

  // 红包雨状态
  const [showRedPacketRain, setShowRedPacketRain] = useState(false);

  // 监听反馈成功，触发红包雨
  useEffect(() => {
    if (feedback.successType) {
      setShowRedPacketRain(true);
    }
  }, [feedback.successType]);

  // 清空（包括反馈状态）
  const handleClear = () => {
    handleChatClear();
    feedback.clearSuccess();
  };

  // 提取最后一条用户消息
  const extractLastUserMessage = (text: string): string | undefined => {
    if (!text.trim()) return undefined;
    const lines = text.split('\n').filter((l) => l.trim());
    // 从后往前找用户消息（格式: [日期时间 候选人] 消息内容）
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const match = line.match(/^\[[\d/]+ [\d:]+ ([^\]]+)\]\s*(.*)$/);
      if (match) {
        const userName = match[1].trim();
        // 招募经理是 AI 回复，其他都视为用户消息
        if (userName !== '招募经理' && userName !== '经理') {
          return match[2];
        }
      }
    }
    return undefined;
  };

  // 提交反馈
  const handleSubmitFeedback = () => {
    const userMessage = extractLastUserMessage(historyText);
    feedback.submit(historyText, userMessage);
  };

  return (
    <div className={styles.chatTester}>
      {/* 主内容区：左右分栏 */}
      <div className={styles.mainContent}>
        {/* 左侧：输入区域 */}
        <div className={styles.inputPanel}>
          <div className={styles.panelHeader}>
            <h3>
              <FileJson size={18} /> 测试输入
            </h3>
            <button onClick={handleClear} className={styles.clearBtn} disabled={isLoading}>
              <Trash2 size={14} /> 清空
            </button>
          </div>

          {/* 可滚动的输入区域 */}
          <div className={styles.inputPanelBody}>
            {/* 历史记录输入 */}
            <div className={styles.inputGroup}>
              <div className={styles.inputLabel}>
                <span className={styles.labelText}>历史聊天记录</span>
                <span className={styles.labelHint}>可选，多轮对话自动回填</span>
                {historyStatus === 'invalid' && (
                  <span className={styles.statusInvalid}>
                    <AlertTriangle size={12} /> 格式有误
                  </span>
                )}
                {historyStatus === 'valid' && (
                  <span className={styles.statusValid}>
                    <Check size={12} /> 格式正确
                  </span>
                )}
              </div>
              <div className={styles.historyInputWrapper}>
                <TextareaAutosize
                  value={historyText}
                  onChange={(e) => setHistoryText(e.target.value)}
                  placeholder={HISTORY_PLACEHOLDER}
                  disabled={isLoading}
                  className={`${styles.historyInput} ${historyStatus === 'invalid' ? styles.inputError : ''}`}
                  minRows={6}
                  maxRows={15}
                />
                <div className={styles.candidateSelectorOverlay}>
                  <CandidateSelector onSelectHistory={setHistoryText} />
                </div>
              </div>
            </div>

            {/* 当前消息输入 */}
            <div className={styles.inputGroup}>
              <div className={styles.inputLabel}>
                <span className={styles.labelText}>当前用户消息</span>
                <span className={styles.labelRequired}>*</span>
              </div>
              <div className={styles.messageInputWrapper}>
                <textarea
                  ref={messageInputRef}
                  value={currentInput}
                  onChange={(e) => setCurrentInput(e.target.value)}
                  placeholder="输入要测试的用户消息..."
                  disabled={isLoading}
                  className={styles.messageInput}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      handleTest();
                    }
                  }}
                />
                <button
                  className={styles.sendIconBtn}
                  onClick={() => handleTest()}
                  disabled={isLoading || !currentInput.trim()}
                >
                  <Send size={16} />
                </button>
              </div>
              <div className={styles.inputHint}>
                按 <kbd>⌘</kbd> + <kbd>Enter</kbd> 快速发送
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：结果区域 */}
        <div className={styles.resultPanel}>
          <div className={styles.panelHeader}>
            <h3>
              <Activity size={18} /> 测试结果
            </h3>
            {result && (
              <div className={`${styles.statusTag} ${styles[result.status]}`}>
                {result.status === 'success' ? (
                  <>
                    <Check size={12} /> 成功
                  </>
                ) : result.status === 'failure' ? (
                  <>
                    <X size={12} /> 失败
                  </>
                ) : (
                  <>
                    <Clock size={12} /> 超时
                  </>
                )}
              </div>
            )}
          </div>

          {/* 可滚动的内容区域 */}
          <div className={styles.scrollableContent} ref={replyContentRef}>
            {/* 错误提示 */}
            {localError && (
              <div className={styles.errorBox}>
                <AlertTriangle className={styles.errorIcon} size={18} />
                <span className={styles.errorText}>{localError}</span>
                <button onClick={() => setLocalError(null)} className={styles.errorClose}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* 无结果状态 */}
            {!latestAssistantMessage && !localError && !isLoading && !result && (
              <div className={styles.emptyState}>
                <div className={styles.emptyIcon}>
                  <Sparkles size={48} strokeWidth={1} />
                </div>
                <p>输入消息并点击"执行测试"</p>
                <p className={styles.emptyHint}>测试结果将在这里显示</p>
              </div>
            )}

            {/* 流式输出中 */}
            {isStreaming && latestAssistantMessage && (
              <div className={styles.streamingContent}>
                <div className={styles.replySection}>
                  <div className={styles.sectionHeader}>
                    <h4>
                      <Radio size={16} className={styles.streamingIcon} /> AI 回复中...
                      <span className={styles.liveTimer}>
                        <Clock size={12} />
                        {Math.floor(elapsedMs / 1000)}s
                      </span>
                    </h4>
                    <button className={styles.cancelBtn} onClick={handleCancel}>
                      <X size={12} /> 取消
                    </button>
                  </div>
                  <MessagePartsAdapter message={latestAssistantMessage} isStreaming={true} />
                </div>
              </div>
            )}

            {/* 加载中状态（仅在流式未开始时显示，start 事件到达后立即切换到流式 UI） */}
            {isLoading && !isStreaming && (
              <div className={styles.loadingState}>
                <div className={styles.loadingSpinner}></div>
                <p>正在连接 Agent API...</p>
              </div>
            )}

            {/* 完成后的测试结果 */}
            {result && !isLoading && latestAssistantMessage && (
              <div className={styles.resultContent}>
                <MetricsRow
                  durationMs={result.metrics.durationMs}
                  tokenUsage={result.metrics.tokenUsage}
                  showDetails={true}
                />

                <div className={styles.replySection}>
                  <div className={styles.sectionHeader}>
                    <h4>
                      <Bot size={16} /> AI 回复
                    </h4>
                  </div>
                  <MessagePartsAdapter message={latestAssistantMessage} isStreaming={false} />
                  {/* 反馈按钮放在右下角 */}
                  <div className={styles.feedbackBtnsRight}>
                    <FeedbackButtons
                      successType={feedback.successType}
                      disabled={!historyText.trim()}
                      onGoodCase={() => feedback.openModal('goodcase')}
                      onBadCase={() => feedback.openModal('badcase')}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 反馈 Modal */}
      <FeedbackModal
        isOpen={feedback.isOpen}
        feedbackType={feedback.feedbackType}
        scenarioType={feedback.scenarioType}
        remark={feedback.remark}
        isSubmitting={feedback.isSubmitting}
        chatHistoryPreview={historyText.trim()}
        submitError={feedback.submitError}
        onClose={feedback.closeModal}
        onScenarioTypeChange={feedback.setScenarioType}
        onRemarkChange={feedback.setRemark}
        onSubmit={handleSubmitFeedback}
      />

      {/* 红包雨特效 - 反馈成功时触发 */}
      <RedPacketRain
        active={showRedPacketRain}
        duration={3000}
        density={30}
        onComplete={() => setShowRedPacketRain(false)}
      />
    </div>
  );
}
