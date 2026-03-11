import { memo, useCallback } from 'react';
import { Activity, ChevronRight, Check, X, Clock, Loader2, AlertTriangle } from 'lucide-react';
import { TestExecution } from '@/api/services/agent-test.service';
import styles from './index.module.scss';

interface CaseListProps {
  executions: TestExecution[];
  currentReviewIndex: number;
  reviewMode: boolean;
  onSelect: (index: number) => void;
}

/** 状态图标配置类型 */
interface StatusIconConfig {
  icon: typeof Check;
  className: string;
  title: string;
}

/** 执行状态图标配置 */
const EXEC_STATUS_CONFIG: Record<string, StatusIconConfig> = {
  success: { icon: Check, className: 'execSuccess', title: '执行成功' },
  failure: { icon: X, className: 'execFailure', title: '执行失败' },
  running: { icon: Loader2, className: 'execRunning', title: '执行中' },
  pending: { icon: Clock, className: 'execPending', title: '等待执行' },
  timeout: { icon: AlertTriangle, className: 'execFailure', title: '执行超时' },
};

/** 评审状态图标配置 */
const REVIEW_STATUS_CONFIG: Record<string, StatusIconConfig> = {
  passed: { icon: Check, className: 'reviewPassed', title: '评审通过' },
  failed: { icon: X, className: 'reviewFailed', title: '评审不通过' },
  pending: { icon: Clock, className: 'reviewPending', title: '待评审' },
  skipped: { icon: Clock, className: 'reviewPending', title: '跳过评审' },
};

/** 分类颜色类名数组 */
const CATEGORY_COLOR_CLASSES = [
  'category1', 'category2', 'category3', 'category4',
  'category5', 'category6', 'category7', 'category8',
  'category9', 'category10', 'category11',
] as const;

/** 获取执行状态图标配置 */
const getExecStatusIcon = (status: string): StatusIconConfig =>
  EXEC_STATUS_CONFIG[status] || EXEC_STATUS_CONFIG.pending;

/** 获取评审状态图标配置 */
const getReviewStatusIcon = (status: string): StatusIconConfig =>
  REVIEW_STATUS_CONFIG[status] || REVIEW_STATUS_CONFIG.pending;

/** 获取分类标签颜色样式类名 */
const getCategoryStyle = (category: string | null | undefined): string => {
  if (!category) return 'categoryDefault';
  const match = category.match(/^(\d+)-/);
  if (!match) return 'categoryDefault';
  const num = parseInt(match[1], 10);
  return CATEGORY_COLOR_CLASSES[(num - 1) % CATEGORY_COLOR_CLASSES.length] || 'categoryDefault';
};

/** 单个用例项组件 */
interface CaseItemProps {
  exec: TestExecution;
  index: number;
  isReviewing: boolean;
  onSelect: (index: number) => void;
}

const CaseItem = memo(function CaseItem({ exec, index, isReviewing, onSelect }: CaseItemProps) {
  const execStatus = getExecStatusIcon(exec.execution_status);
  const reviewStatus = getReviewStatusIcon(exec.review_status);
  const ExecIcon = execStatus.icon;
  const ReviewIcon = reviewStatus.icon;

  const handleClick = useCallback(() => onSelect(index), [onSelect, index]);

  return (
    <div
      className={`${styles.caseItem} ${isReviewing ? styles.reviewing : ''}`}
      onClick={handleClick}
    >
      <div className={styles.caseIndex}>{index + 1}</div>
      <div className={styles.caseContent}>
        <div className={styles.caseNameRow}>
          <span className={styles.caseName}>{exec.case_name || '未命名用例'}</span>
          {exec.category && (
            <span className={`${styles.categoryTag} ${styles[getCategoryStyle(exec.category)]}`}>
              {exec.category}
            </span>
          )}
        </div>
        <div className={styles.caseMessage}>
          {exec.input_message || exec.test_input?.message || '-'}
        </div>
      </div>
      <div className={styles.caseStatus}>
        <div className={styles.statusGroup} title={execStatus.title}>
          <span className={styles.statusLabel}>执行</span>
          <span className={`${styles.statusIcon} ${styles[execStatus.className]}`}>
            <ExecIcon size={12} />
          </span>
        </div>
        <div className={styles.statusGroup} title={reviewStatus.title}>
          <span className={styles.statusLabel}>评审</span>
          <span className={`${styles.statusIcon} ${styles[reviewStatus.className]}`}>
            <ReviewIcon size={12} />
          </span>
        </div>
        <ChevronRight size={14} className={styles.chevron} />
      </div>
    </div>
  );
});

/**
 * 用例列表组件
 */
export function CaseList({ executions, currentReviewIndex, reviewMode, onSelect }: CaseListProps) {
  return (
    <>
      <div className={styles.caseListHeader}>
        <h4>
          <Activity size={16} /> 测试用例
        </h4>
        <span className={styles.caseCount}>共 {executions.length} 条</span>
      </div>

      <div className={styles.caseList}>
        {executions.map((exec, index) => (
          <CaseItem
            key={exec.id}
            exec={exec}
            index={index}
            isReviewing={reviewMode && currentReviewIndex === index}
            onSelect={onSelect}
          />
        ))}
      </div>
    </>
  );
}

export default CaseList;
