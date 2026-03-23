/**
 * 对话详情弹窗骨架屏 Loading 组件
 * 模拟真实内容布局，提供更好的加载体验
 */
import styles from './index.module.scss';

export function LoadingSkeleton() {
  return (
    <div className={styles.detailViewer}>
      {/* 顶部紧凑指标条骨架 */}
      <div className={styles.skeletonMetrics}>
        <div className={styles.skeletonMetricItem}>
          <div className={styles.skeletonIcon} />
          <div className={styles.skeletonMetricValue} />
        </div>
        <div className={styles.skeletonDivider} />
        <div className={styles.skeletonMetricItem}>
          <div className={styles.skeletonIcon} />
          <div className={styles.skeletonMetricValue} />
        </div>
        <div className={styles.skeletonDivider} />
        <div className={styles.skeletonMetricItem}>
          <div className={styles.skeletonIcon} />
          <div className={styles.skeletonMetricValue} />
        </div>
        <div className={styles.skeletonStatusBadge} />
      </div>

      {/* 主内容区骨架 */}
      <div className={styles.mainContent}>
        {/* 左侧：输入区域骨架 */}
        <div className={styles.skeletonInputPanel}>
          {/* 用户消息骨架 */}
          <div className={styles.skeletonSection}>
            <div className={styles.skeletonLabel}>
              <div className={styles.skeletonIcon} />
              <div className={styles.skeletonLabelText} />
            </div>
            <div className={styles.skeletonMessage}>
              <div className={styles.skeletonLine} style={{ width: '85%' }} />
              <div className={styles.skeletonLine} style={{ width: '60%' }} />
            </div>
          </div>

          {/* 历史上下文骨架 */}
          <div className={styles.skeletonSection}>
            <div className={styles.skeletonLabel}>
              <div className={styles.skeletonIcon} />
              <div className={styles.skeletonLabelText} />
            </div>
            <div className={styles.skeletonHistoryList}>
              {[1, 2].map((i) => (
                <div key={i} className={styles.skeletonHistoryItem}>
                  <div className={styles.skeletonLine} style={{ width: '70%' }} />
                  <div className={styles.skeletonLine} style={{ width: '55%' }} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 右侧：回复对比骨架 */}
        <div className={styles.skeletonReplyPanel}>
          {/* 期望回复骨架 */}
          <div className={styles.skeletonSection}>
            <div className={styles.skeletonLabel}>
              <div className={styles.skeletonIcon} />
              <div className={styles.skeletonLabelText} />
            </div>
            <div className={styles.skeletonReplyBox}>
              <div className={styles.skeletonLine} style={{ width: '90%' }} />
              <div className={styles.skeletonLine} style={{ width: '75%' }} />
              <div className={styles.skeletonLine} style={{ width: '80%' }} />
            </div>
          </div>

          {/* 实际回复骨架 */}
          <div className={styles.skeletonSection}>
            <div className={styles.skeletonLabel}>
              <div className={styles.skeletonIcon} />
              <div className={styles.skeletonLabelText} />
            </div>
            <div className={styles.skeletonReplyBox}>
              <div className={styles.skeletonLine} style={{ width: '85%' }} />
              <div className={styles.skeletonLine} style={{ width: '70%' }} />
              <div className={styles.skeletonLine} style={{ width: '65%' }} />
              <div className={styles.skeletonLine} style={{ width: '45%' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default LoadingSkeleton;
