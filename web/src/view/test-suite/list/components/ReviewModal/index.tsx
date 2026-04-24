import { X, Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { TestExecution } from '@/api/services/agent-test.service';
import { AGENT_ERROR_TYPES } from '@/constants';
import { ExecutionDetailViewer } from '../ExecutionDetailViewer';
import { DetailSkeleton } from './DetailSkeleton';
import styles from './index.module.scss';

interface ReviewModalProps {
  execution: TestExecution;
  currentIndex: number;
  totalCount: number;
  showFailureOptions: boolean;
  loading?: boolean;
  detailLoading?: boolean;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onPass: () => void;
  onFail: (reason: string) => void;
  onShowFailureOptions: (show: boolean) => void;
}

/**
 * 评审弹窗组件
 */
export function ReviewModal({
  execution,
  currentIndex,
  totalCount,
  showFailureOptions,
  loading = false,
  detailLoading = false,
  onClose,
  onPrevious,
  onNext,
  onPass,
  onFail,
  onShowFailureOptions,
}: ReviewModalProps) {
  const handleSelectReason = (reason: string) => {
    onFail(reason);
    onShowFailureOptions(false);
  };

  return (
    <div className={styles.reviewModal}>
      <div className={styles.reviewContent}>
        <div className={styles.reviewHeader}>
          <div className={styles.headerTitle}>
            <div className={styles.headerTitleRow}>
              <h3>用例详情</h3>
            </div>
            {(execution.case_name || execution.category) && (
              <div className={styles.headerMetaLine}>
                {execution.case_name && (
                  <span className={styles.headerCaseName}>{execution.case_name}</span>
                )}
                {execution.case_name && execution.category && (
                  <span className={styles.headerMetaDot} aria-hidden="true" />
                )}
                {execution.category && (
                  <span className={styles.headerCategory}>
                    <span>分类</span>
                    <strong>{execution.category}</strong>
                  </span>
                )}
              </div>
            )}
          </div>
          <div className={styles.headerActions}>
            <div className={styles.headerPager} aria-label="用例翻页">
              <button
                type="button"
                disabled={currentIndex === 0}
                onClick={onPrevious}
                title="上一个"
                aria-label="上一个用例"
              >
                <ChevronLeft size={16} />
              </button>
              <span className={styles.headerCounter}>
                {currentIndex + 1} / {totalCount}
              </span>
              <button
                type="button"
                disabled={currentIndex === totalCount - 1}
                onClick={onNext}
                title="下一个"
                aria-label="下一个用例"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="关闭详情"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className={styles.reviewBody}>
          {detailLoading ? (
            <DetailSkeleton />
          ) : (
            <ExecutionDetailViewer execution={execution} showHistory />
          )}
        </div>

        {(showFailureOptions || execution.review_status === 'pending') && (
          <div className={styles.reviewFooter}>
            <div className={styles.reviewActions}>
              {showFailureOptions ? (
                <div className={styles.failureOptions}>
                  <span className={styles.failureLabel}>选择错误原因：</span>
                  <div className={styles.failureReasonList}>
                    {AGENT_ERROR_TYPES.map((type) => (
                      <button
                        type="button"
                        key={type}
                        className={styles.failureReasonBtn}
                        onClick={() => handleSelectReason(type)}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className={styles.cancelFailBtn}
                    onClick={() => onShowFailureOptions(false)}
                  >
                    取消
                  </button>
                </div>
              ) : execution.review_status === 'pending' ? (
                <>
                  {loading ? (
                    <div className={styles.loadingState}>
                      <Loader2 size={20} className={styles.spinner} />
                      <span>处理中...</span>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={styles.failBtn}
                        onClick={() => onShowFailureOptions(true)}
                        data-tip="不通过"
                        aria-label="标记为不通过"
                      >
                        <X size={22} />
                      </button>
                      <button
                        type="button"
                        className={styles.passBtn}
                        onClick={onPass}
                        data-tip="通过"
                        aria-label="标记为通过"
                      >
                        <Check size={22} />
                      </button>
                    </>
                  )}
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default ReviewModal;
