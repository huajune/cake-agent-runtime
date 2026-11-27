import { Bot, BotOff } from 'lucide-react';
import Switch from '@/components/Switch';
import styles from './index.module.scss';

interface GlobalSwitchProps {
  enabled: boolean;
  isPending: boolean;
  onToggle: (enabled: boolean) => void;
}

export default function GlobalSwitch({ enabled, isPending, onToggle }: GlobalSwitchProps) {
  return (
    <section className={styles.section} aria-labelledby="hosting-global-title">
      <div className={styles.sectionHeader}>
        <h2 id="hosting-global-title">全局 AI 托管开关</h2>
        <p className={styles.sectionDesc}>
          控制 Bot 是否响应所有用户消息，关闭后所有消息都不会触发 AI 回复
        </p>
      </div>
      <div className={styles.switchBox}>
        <div className={styles.switchInfo}>
          <div className={`${styles.iconBox} ${enabled ? styles.enabled : styles.disabled}`}>
            {enabled ? (
              <Bot size={22} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <BotOff size={22} strokeWidth={1.75} aria-hidden="true" />
            )}
          </div>
          <div className={styles.statusInfo}>
            <div className={styles.statusTitle}>智能回复 {enabled ? '已启用' : '已禁用'}</div>
            <div className={styles.statusDesc}>
              {enabled ? '已开启托管的小组和用户可收到 AI 回复' : '所有小组的 AI 自动回复已暂停'}
            </div>
          </div>
        </div>
        <label className={styles.toggleSwitch}>
          <Switch
            aria-labelledby="hosting-global-title"
            checked={enabled}
            onChange={onToggle}
            pending={isPending}
          />
          <span className={`${styles.statusText} ${enabled ? styles.enabled : styles.disabled}`}>
            {enabled ? '开启' : '关闭'}
          </span>
        </label>
      </div>
    </section>
  );
}
