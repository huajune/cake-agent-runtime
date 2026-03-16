import styles from './index.module.scss';

/**
 * 执行详情骨架屏组件
 * 模拟 ExecutionDetailViewer 的布局结构
 */
export function DetailSkeleton() {
  return (
    <div className={styles.detailLoadingSkeleton}>
      {/* 顶部指标条骨架 */}
      <div className={styles.skeletonMetrics}>
        <div className={styles.skeletonMetricItem}>
          <div className={styles.skeletonIcon} />
          <div className={styles.skeletonValue} />
        </div>
        <div className={styles.skeletonDivider} />
        <div className={styles.skeletonMetricItem}>
          <div className={styles.skeletonIcon} />
          <div className={styles.skeletonValue} />
        </div>
        <div className={styles.skeletonDivider} />
        <div className={styles.skeletonMetricItem}>
          <div className={styles.skeletonIcon} />
          <div className={styles.skeletonValue} />
        </div>
        <div className={styles.skeletonBadge} />
      </div>

      {/* 主内容区骨架 */}
      <div className={styles.skeletonMainContent}>
        {/* 左侧输入区 */}
        <div className={styles.skeletonInputPanel}>
          <div className={styles.skeletonSection}>
            <div className={styles.skeletonLabel}>
              <div className={styles.skeletonLabelIcon} />
              <div className={styles.skeletonLabelText} />
            </div>
            <div className={styles.skeletonMessage}>
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
            </div>
          </div>
          <div className={styles.skeletonSection}>
            <div className={styles.skeletonLabel}>
              <div className={styles.skeletonLabelIcon} />
              <div className={styles.skeletonLabelText} />
            </div>
            <div className={styles.skeletonHistory}>
              <div className={styles.skeletonHistoryItem}>
                <div className={styles.skeletonAvatar} />
                <div className={styles.skeletonHistoryContent} />
              </div>
              <div className={styles.skeletonHistoryItem}>
                <div className={styles.skeletonAvatar} />
                <div className={styles.skeletonHistoryContent} />
              </div>
            </div>
          </div>
        </div>

        {/* 右侧回复区 */}
        <div className={styles.skeletonReplyPanel}>
          <div className={styles.skeletonSection}>
            <div className={styles.skeletonLabel}>
              <div className={styles.skeletonLabelIcon} />
              <div className={styles.skeletonLabelText} />
            </div>
            <div className={styles.skeletonToolCalls}>
              <div className={styles.skeletonToolItem}>
                <div className={styles.skeletonToolIcon} />
                <div className={styles.skeletonToolName} />
              </div>
            </div>
            <div className={styles.skeletonReplyContent}>
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
              <div className={styles.skeletonLine} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
