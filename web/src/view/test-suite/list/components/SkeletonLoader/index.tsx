import styles from './index.module.scss';

/**
 * 骨架屏加载组件
 */
export function SkeletonLoader() {
  return (
    <div className={styles.loadingState}>
      {/* 统计卡片骨架屏 */}
      <div className={styles.skeletonStats}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className={styles.skeletonStatItem}>
            <div className={styles.skeletonValue} />
            <div className={styles.skeletonLabel} />
          </div>
        ))}
      </div>

      {/* 头部骨架屏 */}
      <div className={styles.skeletonHeader}>
        <div className={styles.skeletonTitle} />
        <div className={styles.skeletonBadge} />
      </div>

      {/* 用例列表骨架屏 */}
      <div className={styles.skeletonCaseList}>
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={styles.skeletonCaseItem}>
            <div className={styles.skeletonIndex} />
            <div className={styles.skeletonContent}>
              <div className={styles.skeletonTitleBar} />
              <div className={styles.skeletonDesc} />
            </div>
            <div className={styles.skeletonStatus}>
              <div className={styles.skeletonBadge} />
              <div className={styles.skeletonBadge} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SkeletonLoader;
