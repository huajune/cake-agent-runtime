import { ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import { FeedbackType } from '@/api/services/agent-test.service';
import styles from './index.module.scss';

export interface FeedbackButtonsProps {
  successType: FeedbackType | null;
  disabled: boolean;
  onGoodCase: () => void;
  onBadCase: () => void;
}

/**
 * 反馈按钮组件
 */
export function FeedbackButtons({
  successType,
  disabled,
  onGoodCase,
  onBadCase,
}: FeedbackButtonsProps) {
  if (successType === 'goodcase') {
    return (
      <span className={styles.feedbackSuccess}>
        <Check size={12} /> 已标记为 Good
      </span>
    );
  }

  if (successType === 'badcase') {
    return (
      <span className={styles.feedbackSuccess}>
        <Check size={12} /> 已标记为 Bad
      </span>
    );
  }

  return (
    <>
      <button
        className={`${styles.feedbackBtn} ${styles.thumbsUp}`}
        onClick={onGoodCase}
        title="标记为 Good Case"
        disabled={disabled}
      >
        <ThumbsUp size={14} />
      </button>
      <button
        className={`${styles.feedbackBtn} ${styles.thumbsDown}`}
        onClick={onBadCase}
        title="标记为 Bad Case"
        disabled={disabled}
      >
        <ThumbsDown size={14} />
      </button>
    </>
  );
}
