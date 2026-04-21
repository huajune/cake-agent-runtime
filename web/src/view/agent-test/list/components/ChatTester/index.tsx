import { memo, useCallback, useRef, useState, type RefObject } from 'react';
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
  ImagePlus,
  IdCard,
  ChevronDown,
  Settings2,
} from 'lucide-react';
import { TestChatResponse } from '@/api/services/agent-test.service';
import type { ModelOption } from '@/api/services/agent.service';
import { MessagePartsAdapter } from '../MessagePartsAdapter';
import { useChatTest, useFeedback, type AgentTestThinkingMode } from '../../hooks';
import { FeedbackModal } from '../FeedbackModal';
import { MetricsRow } from '../MetricsRow';
import { FeedbackButtons } from '../FeedbackButtons';
import { CandidateSelector } from '../CandidateSelector';
import { GroupInviteIdModal } from '../GroupInviteIdModal';
import { ModelSelector } from '@/components/ModelSelector';
import { HISTORY_PLACEHOLDER } from '../../constants';
import styles from './index.module.scss';

interface ChatTesterProps {
  onTestComplete?: (result: TestChatResponse) => void;
}

interface ChatInputPanelProps {
  historyText: string;
  historyStatus: 'valid' | 'invalid' | 'empty';
  currentInput: string;
  imagePreviews: Array<{ id: string; file: File; dataUrl: string }>;
  isLoading: boolean;
  thinkingMode: AgentTestThinkingMode;
  thinkingBudgetTokens: number;
  modelId: string;
  availableModelOptions: ModelOption[];
  setModelId: (modelId: string) => void;
  setHistoryText: (text: string) => void;
  setCurrentInput: (text: string) => void;
  setThinkingMode: (mode: AgentTestThinkingMode) => void;
  setThinkingBudgetTokens: (tokens: number) => void;
  onOpenIdModal: () => void;
  addImages: (files: FileList) => void;
  removeImage: (id: string) => void;
  handleTest: () => Promise<void>;
  handleClear: () => void;
  messageInputRef: RefObject<HTMLTextAreaElement>;
}

function extractLastUserMessage(text: string): string | undefined {
  if (!text.trim()) return undefined;
  const lines = text.split('\n').filter((line) => line.trim());

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(/^\[[\d/]+ [\d:]+ ([^\]]+)\]\s*(.*)$/);
    if (!match) continue;

    const userName = match[1].trim();
    if (userName !== '招募经理' && userName !== '经理') {
      return match[2];
    }
  }

  return undefined;
}

const ChatInputPanel = memo(function ChatInputPanel({
  historyText,
  historyStatus,
  currentInput,
  imagePreviews,
  isLoading,
  thinkingMode,
  thinkingBudgetTokens,
  modelId,
  availableModelOptions,
  setModelId,
  setHistoryText,
  setCurrentInput,
  setThinkingMode,
  setThinkingBudgetTokens,
  onOpenIdModal,
  addImages,
  removeImage,
  handleTest,
  handleClear,
  messageInputRef,
}: ChatInputPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const selectedModelOption = availableModelOptions.find((o) => o.id === modelId);
  const advancedModelSummary = modelId
    ? selectedModelOption?.name || modelId
    : '默认模型';

  return (
    <div className={styles.inputPanel}>
      <div className={styles.panelHeader}>
        <h3>
          <FileJson size={18} /> 测试输入
        </h3>
        <div className={styles.headerActions}>
          <button onClick={onOpenIdModal} className={styles.idConfigBtn} disabled={isLoading}>
            <IdCard size={14} /> 拉群ID
          </button>
          <button onClick={handleClear} className={styles.clearBtn} disabled={isLoading}>
            <Trash2 size={14} /> 重置会话
          </button>
        </div>
      </div>

      <div className={styles.inputPanelBody}>
        <div className={styles.advancedSection}>
          <button
            type="button"
            className={styles.advancedToggle}
            onClick={() => setIsAdvancedOpen((prev) => !prev)}
            aria-expanded={isAdvancedOpen}
          >
            <span className={styles.advancedToggleLabel}>
              <Settings2 size={14} /> 高级设置
            </span>
            <span className={styles.advancedSummary}>
              {advancedModelSummary} · {thinkingMode === 'deep' ? '深度思考' : '极速'}
            </span>
            <ChevronDown
              size={16}
              className={`${styles.advancedChevron} ${isAdvancedOpen ? styles.advancedChevronOpen : ''}`}
            />
          </button>

          {isAdvancedOpen && (
            <div className={styles.advancedBody}>
              <div className={styles.modeSwitchGroup}>
                <div className={styles.inputLabel}>
                  <span className={styles.labelText}>聊天模型</span>
                  <span className={styles.labelHint}>留空使用后端默认角色路由</span>
                </div>
                <div className={styles.modeControls}>
                  <ModelSelector
                    value={modelId}
                    options={availableModelOptions}
                    onChange={setModelId}
                    disabled={isLoading}
                  />
                </div>
              </div>

              <div className={styles.modeSwitchGroup}>
                <div className={styles.inputLabel}>
                  <span className={styles.labelText}>回复模式</span>
                  <span className={styles.labelHint}>极速更快，深度会展示完整思考过程</span>
                </div>
                <div className={styles.modeControls}>
                  <div className={styles.modeSegment} role="tablist" aria-label="回复模式">
                    <button
                      type="button"
                      className={`${styles.modeOption} ${thinkingMode === 'fast' ? styles.modeOptionActive : ''}`}
                      onClick={() => setThinkingMode('fast')}
                      disabled={isLoading}
                    >
                      <Clock size={14} /> 极速
                    </button>
                    <button
                      type="button"
                      className={`${styles.modeOption} ${thinkingMode === 'deep' ? styles.modeOptionActive : ''}`}
                      onClick={() => setThinkingMode('deep')}
                      disabled={isLoading}
                    >
                      <Sparkles size={14} /> 深度思考
                    </button>
                  </div>
                  {thinkingMode === 'deep' && (
                    <label className={styles.budgetField}>
                      <span className={styles.budgetLabel}>预算</span>
                      <div className={styles.budgetInputWrap}>
                        <input
                          type="number"
                          min={500}
                          max={20000}
                          step={500}
                          value={thinkingBudgetTokens}
                          disabled={isLoading}
                          className={styles.budgetInput}
                          onChange={(e) => {
                            const nextValue = Number(e.target.value);
                            if (!Number.isFinite(nextValue)) return;
                            setThinkingBudgetTokens(nextValue);
                          }}
                        />
                        <span className={styles.budgetSuffix}>tokens</span>
                      </div>
                    </label>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

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
            <textarea
              value={historyText}
              onChange={(e) => setHistoryText(e.target.value)}
              placeholder={HISTORY_PLACEHOLDER}
              disabled={isLoading}
              className={`${styles.historyInput} ${historyStatus === 'invalid' ? styles.inputError : ''}`}
              rows={15}
            />
            <div className={styles.candidateSelectorOverlay}>
              <CandidateSelector onSelectHistory={setHistoryText} />
            </div>
          </div>
        </div>

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
                  void handleTest();
                }
              }}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;

                const imageFiles: File[] = [];
                for (const item of Array.from(items)) {
                  if (!item.type.startsWith('image/')) continue;
                  const file = item.getAsFile();
                  if (file) imageFiles.push(file);
                }

                if (imageFiles.length > 0) {
                  e.preventDefault();
                  const dt = new DataTransfer();
                  imageFiles.forEach((file) => dt.items.add(file));
                  addImages(dt.files);
                }
              }}
            />
            <div className={styles.messageInputActions}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) {
                    addImages(e.target.files);
                    e.target.value = '';
                  }
                }}
              />
              <button
                className={styles.imageUploadBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                title="上传图片"
              >
                <ImagePlus size={16} />
              </button>
              <button
                className={styles.sendIconBtn}
                onClick={() => void handleTest()}
                disabled={isLoading || (!currentInput.trim() && imagePreviews.length === 0)}
              >
                <Send size={16} />
              </button>
            </div>
          </div>

          {imagePreviews.length > 0 && (
            <div className={styles.imagePreviews}>
              {imagePreviews.map((img) => (
                <div key={img.id} className={styles.imagePreviewItem}>
                  <img src={img.dataUrl} alt={img.file.name} />
                  <button
                    className={styles.imageRemoveBtn}
                    onClick={() => removeImage(img.id)}
                    disabled={isLoading}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className={styles.inputHint}>
            按 <kbd>⌘</kbd> + <kbd>Enter</kbd> 快速发送，支持粘贴图片和纯图片测试
          </div>
        </div>
      </div>
    </div>
  );
});

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
    latestAssistantMessage,
    imagePreviews,
    addImages,
    removeImage,
    userId,
    botUserId,
    botImId,
    setUserId,
    setBotUserId,
    setBotImId,
    thinkingMode,
    thinkingBudgetTokens,
    modelId,
    availableModelOptions,
    setModelId,
    setHistoryText,
    setCurrentInput,
    setLocalError,
    setThinkingMode,
    setThinkingBudgetTokens,
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

  const [isIdModalOpen, setIsIdModalOpen] = useState(false);

  // 清空（包括反馈状态）
  const handleClear = useCallback(() => {
    handleChatClear();
    feedback.clearSuccess();
  }, [feedback.clearSuccess, handleChatClear]);

  // 提交反馈
  const handleSubmitFeedback = useCallback(() => {
    const userMessage = extractLastUserMessage(historyText);
    void feedback.submit({
      chatHistory: historyText,
      userMessage,
    });
  }, [feedback.submit, historyText]);

  return (
    <div className={styles.chatTester}>
      {/* 主内容区：左右分栏 */}
      <div className={styles.mainContent}>
        <ChatInputPanel
          historyText={historyText}
          historyStatus={historyStatus}
          currentInput={currentInput}
          imagePreviews={imagePreviews}
          isLoading={isLoading}
          onOpenIdModal={() => setIsIdModalOpen(true)}
          thinkingMode={thinkingMode}
          thinkingBudgetTokens={thinkingBudgetTokens}
          modelId={modelId}
          availableModelOptions={availableModelOptions}
          setModelId={setModelId}
          setHistoryText={setHistoryText}
          setCurrentInput={setCurrentInput}
          setThinkingMode={setThinkingMode}
          setThinkingBudgetTokens={setThinkingBudgetTokens}
          addImages={addImages}
          removeImage={removeImage}
          handleTest={handleTest}
          handleClear={handleClear}
          messageInputRef={messageInputRef}
        />

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

            {/* 加载/流式输出中 */}
            {isLoading && (
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
                  <MessagePartsAdapter
                    message={latestAssistantMessage ?? { id: 'loading', role: 'assistant' as const, parts: [] }}
                    isStreaming={true}
                    renderTextAsMarkdown={true}
                  />
                </div>
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
                  <MessagePartsAdapter
                    message={latestAssistantMessage}
                    isStreaming={false}
                    renderTextAsMarkdown={true}
                  />
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

      <GroupInviteIdModal
        isOpen={isIdModalOpen}
        value={{ userId, botUserId, botImId }}
        onClose={() => setIsIdModalOpen(false)}
        onSave={(nextValue) => {
          setUserId(nextValue.userId);
          setBotUserId(nextValue.botUserId);
          setBotImId(nextValue.botImId);
        }}
      />
    </div>
  );
}
