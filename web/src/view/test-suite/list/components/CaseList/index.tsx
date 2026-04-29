import { memo, useCallback } from 'react';
import {
  Activity,
  ChevronRight,
  Check,
  X,
  Clock,
  Loader2,
  AlertTriangle,
  Play,
  MessageCircle,
} from 'lucide-react';
import { TestExecution } from '@/api/services/agent-test.service';
import { getCategoryStyleClass } from '../../utils';
import styles from './index.module.scss';

interface CaseListProps {
  executions: TestExecution[];
  currentReviewIndex: number;
  reviewMode: boolean;
  onSelect: (index: number) => void;
  onExecute?: (executionId: string) => void;
  executing?: string | null;
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

/** 获取执行状态图标配置 */
const getExecStatusIcon = (status: string): StatusIconConfig =>
  EXEC_STATUS_CONFIG[status] || EXEC_STATUS_CONFIG.pending;

/** 获取评审状态图标配置 */
const getReviewStatusIcon = (status: string): StatusIconConfig =>
  REVIEW_STATUS_CONFIG[status] || REVIEW_STATUS_CONFIG.pending;

/** 单个用例项组件 */
interface CaseItemProps {
  exec: TestExecution;
  index: number;
  isReviewing: boolean;
  onSelect: (index: number) => void;
  onExecute?: (executionId: string) => void;
  executing?: string | null;
}

const CaseItem = memo(function CaseItem({
  exec,
  index,
  isReviewing,
  onSelect,
  onExecute,
  executing,
}: CaseItemProps) {
  const execStatus = getExecStatusIcon(exec.execution_status);
  const reviewStatus = getReviewStatusIcon(exec.review_status);
  const ExecIcon = execStatus.icon;
  const ReviewIcon = reviewStatus.icon;
  const isExecuting = executing === exec.id || exec.execution_status === 'running';
  const canRerun =
    !!onExecute &&
    (exec.review_status === 'failed' ||
      exec.execution_status === 'failure' ||
      exec.execution_status === 'timeout' ||
      exec.execution_status === 'running');

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
          {typeof exec.dialogue_turn_count === 'number' && exec.dialogue_turn_count > 0 && (
            <span className={styles.turnTag} title={`对话轮数：${exec.dialogue_turn_count} 轮`}>
              <MessageCircle size={10} />
              {exec.dialogue_turn_count} 轮
            </span>
          )}
          {exec.category && (
            <span
              className={`${styles.categoryTag} ${styles[getCategoryStyleClass(exec.category)]}`}
            >
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
        {canRerun && (
          <button
            type="button"
            className={styles.executeBtn}
            onClick={(event) => {
              event.stopPropagation();
              onExecute?.(exec.id);
            }}
            disabled={isExecuting}
            title="重新跑该用例"
            aria-label={`重新跑 ${exec.case_name || '未命名用例'}`}
          >
            {isExecuting ? <Loader2 size={12} className={styles.spinning} /> : <Play size={12} />}
          </button>
        )}
        <ChevronRight size={14} className={styles.chevron} />
      </div>
    </div>
  );
});

/**
 * 用例列表组件
 */
export function CaseList({
  executions,
  currentReviewIndex,
  reviewMode,
  onSelect,
  onExecute,
  executing,
}: CaseListProps) {
  const safeExecutions = Array.isArray(executions) ? executions : [];

  return (
    <>
      <div className={styles.caseListHeader}>
        <h4>
          <Activity size={16} /> 测试用例
        </h4>
        <span className={styles.caseCount}>共 {safeExecutions.length} 条</span>
      </div>

      <div className={styles.caseList}>
        {safeExecutions.map((exec, index) => (
          <CaseItem
            key={exec.id}
            exec={exec}
            index={index}
            isReviewing={reviewMode && currentReviewIndex === index}
            onSelect={onSelect}
            onExecute={onExecute}
            executing={executing}
          />
        ))}
      </div>
    </>
  );
}

export default CaseList;
