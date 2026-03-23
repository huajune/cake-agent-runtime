import styles from './index.module.scss';

interface WorkerStatus {
  concurrency: number;
  minConcurrency: number;
  maxConcurrency: number;
  activeJobs: number;
  messageMergeEnabled: boolean;
}

interface WorkerPanelProps {
  isLoading: boolean;
  workerStatus?: WorkerStatus;
  editingConcurrency: number | null;
  isPending: boolean;
  isTogglingMerge: boolean;
  onConcurrencyChange: (value: number) => void;
  onApply: () => void;
  onCancel: () => void;
  onToggleMessageMerge: (enabled: boolean) => void;
}

export default function WorkerPanel({
  isLoading,
  workerStatus,
  editingConcurrency,
  isPending,
  isTogglingMerge,
  onConcurrencyChange,
  onApply,
  onCancel,
  onToggleMessageMerge,
}: WorkerPanelProps) {
  if (isLoading) {
    return <div className={styles.loadingText}>加载 Worker 状态...</div>;
  }

  if (!workerStatus) {
    return <div className={styles.errorText}>无法获取 Worker 状态</div>;
  }

  const currentValue = editingConcurrency ?? workerStatus.concurrency;
  const hasChanges = editingConcurrency !== null && editingConcurrency !== workerStatus.concurrency;

  return (
    <div className={styles.panel}>
      {/* 消息聚合开关 */}
      <div className={styles.toggleSection}>
        <div className={styles.toggleHeader}>
          <div className={styles.toggleInfo}>
            <span className={styles.toggleLabel}>消息聚合</span>
            <span className={styles.toggleStatus}>
              {workerStatus.messageMergeEnabled ? '已启用' : '已禁用'}
            </span>
          </div>
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={workerStatus.messageMergeEnabled}
              onChange={(e) => onToggleMessageMerge(e.target.checked)}
              disabled={isTogglingMerge}
            />
            <span className={styles.switchSlider}></span>
          </label>
        </div>
        <p className={styles.toggleDescription}>
          启用后，系统会等待一段时间收集连续消息后合并处理，减少 API 调用次数。适合用户快速发送多条消息的场景。
        </p>
      </div>

      <div className={styles.divider}></div>

      {/* Worker 状态指示 */}
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
        控制同时处理消息的 Worker 数量。增加并发数可提高吞吐量，但会增加 Agent API 压力。修改后会等待当前任务完成再生效。
      </p>

      <div className={styles.formula}>
        <div>理论吞吐量 = 并发数 × (时间 / 平均首响时间)</div>
        <div className={styles.formulaExample}>
          例: {currentValue} 并发 × (60s / 10s首响) ≈{' '}
          <strong className={styles.highlight}>{(currentValue * 6).toLocaleString()}</strong> 条/分钟 ≈{' '}
          <strong className={styles.highlight}>{(currentValue * 360).toLocaleString()}</strong> 条/小时
        </div>
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
