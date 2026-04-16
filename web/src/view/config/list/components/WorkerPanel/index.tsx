import styles from './index.module.scss';

interface WorkerStatus {
  concurrency: number;
  minConcurrency: number;
  maxConcurrency: number;
  activeJobs: number;
}

interface WorkerPanelProps {
  isLoading: boolean;
  workerStatus?: WorkerStatus;
  editingConcurrency: number | null;
  isPending: boolean;
  averageE2EMs: number | null;
  e2eSampleCount: number;
  onConcurrencyChange: (value: number) => void;
  onApply: () => void;
  onCancel: () => void;
}

export default function WorkerPanel({
  isLoading,
  workerStatus,
  editingConcurrency,
  isPending,
  averageE2EMs,
  e2eSampleCount,
  onConcurrencyChange,
  onApply,
  onCancel,
}: WorkerPanelProps) {
  if (isLoading) {
    return <div className={styles.loadingText}>加载 Worker 状态...</div>;
  }

  if (!workerStatus) {
    return <div className={styles.errorText}>无法获取 Worker 状态</div>;
  }

  const currentValue = editingConcurrency ?? workerStatus.concurrency;
  const hasChanges = editingConcurrency !== null && editingConcurrency !== workerStatus.concurrency;
  const averageE2ESeconds = averageE2EMs !== null ? averageE2EMs / 1000 : null;
  const throughputPerMinute =
    averageE2ESeconds && averageE2ESeconds > 0 ? (currentValue * 60) / averageE2ESeconds : null;
  const throughputPerHour = throughputPerMinute !== null ? throughputPerMinute * 60 : null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.label}>Worker 并发数</span>
          {workerStatus.activeJobs > 0 && (
            <span className={styles.activeJobs}>({workerStatus.activeJobs} 任务中)</span>
          )}
        </div>
        <span className={styles.value}>{currentValue}</span>
      </div>

      <p className={styles.description}>
        控制同时处理消息请求的 Worker 数量。提高并发能放大吞吐，但也会提升 Agent API 和队列压力。
      </p>

      <div className={styles.formula}>
        <div>理论吞吐量 = 并发数 × (时间 / 平均 E2E 时延)</div>
        {averageE2ESeconds !== null && throughputPerMinute !== null && throughputPerHour !== null ? (
          <div className={styles.formulaExample}>
            基于最近 {e2eSampleCount} 条成功请求的平均 E2E{' '}
            <strong className={styles.highlight}>{averageE2ESeconds.toFixed(1)}s</strong>：
            {currentValue} 并发 × (60s / {averageE2ESeconds.toFixed(1)}s) ≈{' '}
            <strong className={styles.highlight}>{throughputPerMinute.toFixed(1)}</strong> 条/分钟 ≈{' '}
            <strong className={styles.highlight}>{throughputPerHour.toFixed(0)}</strong> 条/小时
          </div>
        ) : (
          <div className={styles.formulaExample}>暂无可用的 E2E 生产数据，暂时无法估算真实吞吐。</div>
        )}
      </div>

      {/* 滑块控制 */}
      <div className={styles.sliderRow}>
        <input
          type="range"
          className={styles.slider}
          min={workerStatus.minConcurrency}
          max={workerStatus.maxConcurrency}
          step={1}
          value={currentValue}
          onChange={(e) => onConcurrencyChange(Number(e.target.value))}
        />
        <input
          type="number"
          className={styles.numberInput}
          min={workerStatus.minConcurrency}
          max={workerStatus.maxConcurrency}
          step={1}
          value={currentValue}
          onChange={(e) => onConcurrencyChange(Number(e.target.value))}
        />
      </div>

      {/* 范围提示 & 操作按钮 */}
      <div className={styles.footer}>
        <span className={styles.rangeHint}>
          {workerStatus.minConcurrency} - {workerStatus.maxConcurrency}（默认: 4）
        </span>

        {hasChanges && (
          <div className={styles.actions}>
            <button className={styles.btnGhost} onClick={onCancel}>
              取消
            </button>
            <button className={styles.btnPrimary} onClick={onApply} disabled={isPending}>
              {isPending ? '应用中...' : '应用'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
