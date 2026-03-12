import { createPortal } from 'react-dom';
import { X, Loader2, Sparkles, AlertTriangle } from 'lucide-react';
import { FeedbackType } from '@/api/services/agent-test.service';
import { SCENARIO_TYPE_OPTIONS } from '../../constants';
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
  onClose,
  onScenarioTypeChange,
  onRemarkChange,
  onSubmit,
}: FeedbackModalProps) {
  if (!isOpen) return null;

  const isGoodCase = feedbackType === 'goodcase';

  const modalContent = (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
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
                options={SCENARIO_TYPE_OPTIONS}
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
              placeholder="添加备注说明..."
              className={styles.formTextarea}
              rows={3}
            />
          </div>

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
