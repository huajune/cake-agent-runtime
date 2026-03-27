import { useCallback, useState } from 'react';
import { useUpdateGroupTaskConfig, useTriggerGroupTask } from '@/hooks/config/useGroupTask';
import type { GroupTaskConfig } from '@/api/types/config.types';
import styles from './index.module.scss';

const TASK_TYPES = [
  { type: 'part_time', icon: '📋', name: '兼职群', desc: '岗位推荐' },
  { type: 'order_grab', icon: '🍕', name: '抢单群', desc: '订单推送' },
  { type: 'store_manager', icon: '👔', name: '店长群', desc: '面试名单' },
  { type: 'work_tips', icon: '💡', name: '工作小贴士', desc: '周六推送' },
];

interface GroupTaskPanelProps {
  config?: GroupTaskConfig;
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  statusLabel: string;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  variant?: 'default' | 'warning';
}

function ToggleRow({
  label,
  description,
  checked,
  statusLabel,
  disabled,
  onChange,
  variant = 'default',
}: ToggleRowProps) {
  return (
    <div className={styles.toggleRow}>
      <div className={styles.toggleInfo}>
        <div className={styles.toggleTitleRow}>
          <span className={styles.toggleLabel}>{label}</span>
          <span
            className={`${styles.statusBadge} ${checked ? styles.statusOn : styles.statusOff} ${variant === 'warning' && checked ? styles.statusWarning : ''}`}
          >
            <span className={styles.statusDot} />
            {statusLabel}
          </span>
        </div>
        <span className={styles.toggleDescription}>{description}</span>
      </div>
      <label className={`${styles.switch} ${disabled ? styles.switchDisabled : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={styles.switchTrack}>
          <span className={styles.switchThumb} />
        </span>
      </label>
    </div>
  );
}

export default function GroupTaskPanel({ config }: GroupTaskPanelProps) {
  const updateConfig = useUpdateGroupTaskConfig();
  const triggerTask = useTriggerGroupTask();
  const [loadingType, setLoadingType] = useState<string | null>(null);

  const handleEnabledChange = useCallback(
    (checked: boolean) => {
      updateConfig.mutate({ enabled: checked });
    },
    [updateConfig],
  );

  const handleDryRunChange = useCallback(
    (checked: boolean) => {
      updateConfig.mutate({ dryRun: checked });
    },
    [updateConfig],
  );

  return (
    <div className={styles.panel}>
      {/* 定时任务总开关 */}
      <ToggleRow
        label="定时任务"
        description="开启后 Cron 定时触发群通知，按计划自动推送消息"
        checked={config?.enabled ?? false}
        statusLabel={config?.enabled ? '运行中' : '已停止'}
        disabled={updateConfig.isPending}
        onChange={handleEnabledChange}
      />

      <div className={styles.divider} />

      {/* 试运行模式 */}
      <ToggleRow
        label="试运行模式"
        description="开启时只发飞书预览，关闭后正式发到企微群"
        checked={config?.dryRun ?? true}
        statusLabel={config?.dryRun ? '预览模式' : '正式推送'}
        disabled={updateConfig.isPending}
        onChange={handleDryRunChange}
        variant="warning"
      />

      <div className={styles.divider} />

      {/* 手动触发区域 */}
      <div className={styles.triggerSection}>
        <div className={styles.triggerHeader}>
          <span className={styles.triggerSectionLabel}>手动触发</span>
          <span className={styles.triggerHint}>立即执行单次任务</span>
        </div>
        <div className={styles.triggerGrid}>
          {TASK_TYPES.map(({ type, icon, name, desc }) => (
            <button
              key={type}
              className={styles.triggerCard}
              disabled={loadingType !== null}
              onClick={() => {
                setLoadingType(type);
                triggerTask.mutate(type, {
                  onSettled: () => setLoadingType(null),
                });
              }}
            >
              <span className={styles.triggerIconWrap}>
                <span className={styles.triggerIcon}>{icon}</span>
              </span>
              <div className={styles.triggerContent}>
                <span className={styles.triggerName}>{name}</span>
                <span className={styles.triggerDesc}>{desc}</span>
              </div>
              <span className={styles.triggerArrow}>
                {loadingType === type ? '...' : '›'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
