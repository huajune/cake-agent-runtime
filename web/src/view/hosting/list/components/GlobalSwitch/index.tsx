import styles from './index.module.scss';

interface GlobalSwitchProps {
  enabled: boolean;
  isPending: boolean;
  onToggle: (enabled: boolean) => void;
}

export default function GlobalSwitch({ enabled, isPending, onToggle }: GlobalSwitchProps) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h3>全局 AI 托管开关</h3>
        <p className={styles.sectionDesc}>
          控制 Bot 是否响应所有用户消息，关闭后所有消息都不会触发 AI 回复
        </p>
      </div>
      <div className={styles.switchBox}>
        <div className={styles.switchInfo}>
          <div className={`${styles.iconBox} ${enabled ? styles.enabled : styles.disabled}`}>
            {enabled ? '🤖' : '🔇'}
          </div>
          <div className={styles.statusInfo}>
            <div className={styles.statusTitle}>
              智能回复 {enabled ? '已启用' : '已禁用'}
            </div>
            <div className={styles.statusDesc}>
              {enabled
                ? '所有用户消息将触发 AI 自动回复'
                : '所有用户消息将被忽略，不触发 AI 回复'}
            </div>
          </div>
        </div>
        <label className={styles.toggleSwitch}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={isPending}
          />
          <span className={`${styles.statusText} ${enabled ? styles.enabled : styles.disabled}`}>
            {enabled ? '开启' : '关闭'}
          </span>
        </label>
      </div>
    </section>
  );
}
