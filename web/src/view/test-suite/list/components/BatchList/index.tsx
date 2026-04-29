import { useRef, useCallback, useEffect } from 'react';
import { FolderOpen, Sparkles, Loader2 } from 'lucide-react';
import { TestBatch } from '@/api/services/agent-test.service';
import { formatDateTime } from '@/utils/format';
import { getBatchStatusDisplay } from '../../constants';
import styles from './index.module.scss';

interface BatchListProps {
  batches: TestBatch[];
  selectedBatch: TestBatch | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  total: number;
  onSelect: (batch: TestBatch) => void;
  onLoadMore: () => void;
}

/** 将历史批次名称中的旧术语替换为新术语 */
function normalizeBatchName(name: string): string {
  return name.replace('场景测试', '用例测试').replace('对话验证', '回归验证');
}

/**
 * 批次列表组件（支持无限滚动）
 */
export function BatchList({
  batches,
  selectedBatch,
  loading,
  loadingMore,
  hasMore,
  total,
  onSelect,
  onLoadMore,
}: BatchListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

  // 设置 Intersection Observer 监听滚动到底部
  const setupObserver = useCallback(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting && hasMore && !loadingMore && !loading) {
          onLoadMore();
        }
      },
      {
        root: listRef.current,
        rootMargin: '100px', // 提前 100px 触发加载
        threshold: 0,
      },
    );

    if (loadMoreTriggerRef.current) {
      observerRef.current.observe(loadMoreTriggerRef.current);
    }
  }, [hasMore, loadingMore, loading, onLoadMore]);

  useEffect(() => {
    setupObserver();
    return () => {
      observerRef.current?.disconnect();
    };
  }, [setupObserver]);

  return (
    <div className={styles.batchPanel}>
      <div className={styles.panelHeader}>
        <h3>
          <FolderOpen size={18} /> 测试批次
        </h3>
        <span className={styles.badge}>{total}</span>
      </div>

      <div className={styles.batchList} ref={listRef}>
        {loading && batches.length === 0 ? (
          <div className={`${styles.loadingState} ${styles.centered}`}>
            <div className={styles.spinner} />
            <p>加载中...</p>
          </div>
        ) : batches.length === 0 ? (
          <div className={styles.emptyState}>
            <Sparkles size={40} strokeWidth={1} />
            <p>暂无测试批次</p>
            <p className={styles.hint}>点击"一键测试"创建</p>
          </div>
        ) : (
          <>
            {batches.map((batch) => {
              const status = getBatchStatusDisplay(batch.status);
              const isConversation = batch.test_type === 'conversation';
              const reviewedCount = batch.total_cases - (batch.pending_review_count || 0);
              const createdAt = formatDateTime(batch.created_at);
              return (
                <div
                  key={batch.id}
                  className={`${styles.batchItem} ${selectedBatch?.id === batch.id ? styles.selected : ''}`}
                  onClick={() => onSelect(batch)}
                >
                  {/* 第一行：标题 + 状态 */}
                  <div className={styles.batchRow}>
                    <div className={styles.batchName}>{normalizeBatchName(batch.name)}</div>
                    <span className={`${styles.batchStatusTag} ${styles[status.className]}`}>
                      {status.text}
                    </span>
                  </div>
                  {/* 第二行：统计信息 */}
                  <div className={styles.batchMeta}>
                    {/* 回归验证显示"对话"，用例测试显示"用例" */}
                    <span>{isConversation ? '对话' : '用例'} {batch.total_cases}</span>
                    <span className={styles.sep}>·</span>
                    {/* 回归验证显示执行进度，用例测试显示评审进度 */}
                    {isConversation ? (
                      <span>
                        完成{' '}
                        {batch.total_cases > 0
                          ? Math.round((batch.executed_count / batch.total_cases) * 100)
                          : 0}
                        %
                      </span>
                    ) : (
                      <span>
                        评审{' '}
                        {batch.total_cases > 0
                          ? Math.round((reviewedCount / batch.total_cases) * 100)
                          : 0}
                        %
                      </span>
                    )}
                    <span className={styles.sep}>·</span>
                    {/* 回归验证显示平均评分，用例测试显示通过率 */}
                    <span>
                      {isConversation ? '评分' : '通过'}{' '}
                      {batch.pass_rate !== null
                        ? isConversation
                          ? `${batch.pass_rate.toFixed(0)}分`
                          : `${batch.pass_rate.toFixed(0)}%`
                        : '-'}
                    </span>
                  </div>
                  <time className={styles.batchCreatedAt} dateTime={batch.created_at}>
                    创建时间 {createdAt}
                  </time>
                </div>
              );
            })}

            {/* 加载更多触发器 */}
            <div ref={loadMoreTriggerRef} className={styles.loadMoreTrigger}>
              {loadingMore && (
                <div className={styles.loadingMore}>
                  <Loader2 size={16} className={styles.spinningIcon} />
                  <span>加载中...</span>
                </div>
              )}
              {!hasMore && batches.length > 0 && (
                <div className={styles.noMore}>没有更多了</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default BatchList;
