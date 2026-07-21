import { useRef } from 'react';
import type { ClipboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, Sparkles, AlertTriangle, ImagePlus } from 'lucide-react';
import { FeedbackType } from '@/api/services/agent-test.service';
import { SCENARIO_TYPE_OPTIONS } from '../../constants';
import { MAX_FEEDBACK_SCREENSHOTS } from '../../hooks/useFeedback';
import { CustomSelect } from '../CustomSelect';
import styles from './index.module.scss';

export interface FeedbackModalProps {
  isOpen: boolean;
  feedbackType: FeedbackType | null;
  scenarioType: string;
  remark: string;
  isSubmitting: boolean;
  chatHistoryPreview: string;
  submitError?: string | null;
  /** 场景分类选项，缺省为主聊 13 类；复聊页传入专属选项 */
  scenarioOptions?: Array<{ value: string; label: string }>;
  screenshots?: string[];
  onAddScreenshots?: (files: Iterable<File>) => void;
  onRemoveScreenshot?: (index: number) => void;
  onClose: () => void;
  onScenarioTypeChange: (type: string) => void;
  onRemarkChange: (remark: string) => void;
  onSubmit: () => void;
}

/**
 * 反馈 Modal 组件 - 使用 Portal 渲染到 body
 */
export function FeedbackModal({
  isOpen,
  feedbackType,
  scenarioType,
  remark,
  isSubmitting,
  chatHistoryPreview,
  submitError,
  scenarioOptions = SCENARIO_TYPE_OPTIONS,
  screenshots = [],
  onAddScreenshots,
  onRemoveScreenshot,
  onClose,
  onScenarioTypeChange,
  onRemarkChange,
  onSubmit,
}: FeedbackModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const isGoodCase = feedbackType === 'goodcase';
  const screenshotsEnabled = !!onAddScreenshots;
  const screenshotsFull = screenshots.length >= MAX_FEEDBACK_SCREENSHOTS;

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (!onAddScreenshots) return;
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length > 0) {
      event.preventDefault();
      onAddScreenshots(files);
    }
  };

  const modalContent = (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} onPaste={handlePaste}>
        {/* 装饰元素 */}
        <div className={styles.modalDecor}>
          <div className={styles.decorCircle1} />
          <div className={styles.decorCircle2} />
        </div>

        <div className={styles.modalHeader}>
          <h3>
            {isGoodCase ? '标记为 Good Case' : '标记为 Bad Case'}
          </h3>
          <button className={styles.modalClose} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.modalBody}>
          {/* 错误提示 */}
          {submitError && (
            <div className={styles.submitError}>
              <AlertTriangle size={14} />
              <span>{submitError}</span>
            </div>
          )}

          {!isGoodCase && (
            <div className={styles.formGroup}>
              <label>场景分类（可选）</label>
              <CustomSelect
                value={scenarioType}
                options={scenarioOptions}
                onChange={onScenarioTypeChange}
                placeholder="请选择..."
              />
            </div>
          )}

          <div className={styles.formGroup}>
            <label>备注（可选）</label>
            <textarea
              value={remark}
              onChange={(e) => onRemarkChange(e.target.value)}
              placeholder="添加备注说明...（可直接粘贴截图）"
              className={styles.formTextarea}
              rows={3}
            />
          </div>

          {screenshotsEnabled && (
            <div className={styles.formGroup}>
              <label>
                截图（可选，最多 {MAX_FEEDBACK_SCREENSHOTS} 张，可粘贴）
              </label>
              <div className={styles.screenshotGrid}>
                {screenshots.map((dataUrl, index) => (
                  <div key={index} className={styles.screenshotThumb}>
                    <img src={dataUrl} alt={`截图 ${index + 1}`} />
                    <button
                      type="button"
                      className={styles.screenshotRemove}
                      onClick={() => onRemoveScreenshot?.(index)}
                      aria-label={`删除截图 ${index + 1}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {!screenshotsFull && (
                  <button
                    type="button"
                    className={styles.screenshotAdd}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <ImagePlus size={18} />
                    <span>添加</span>
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) {
                    onAddScreenshots(e.target.files);
                  }
                  e.target.value = '';
                }}
              />
            </div>
          )}

          <div className={styles.chatPreview}>
            <label>
              <Sparkles size={12} /> 将提交的聊天记录
              <span className={styles.charCount}>
                {chatHistoryPreview.length} 字符
              </span>
            </label>
            <pre>{chatHistoryPreview}</pre>
          </div>
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>
            取消
          </button>
          <button className={styles.submitBtn} onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 size={14} className={styles.spinning} /> 提交中...
              </>
            ) : (
              '确认提交'
            )}
          </button>
        </div>
      </div>
    </div>
  );

  // 使用 Portal 渲染到 body，确保层级最高
  return createPortal(modalContent, document.body);
}
