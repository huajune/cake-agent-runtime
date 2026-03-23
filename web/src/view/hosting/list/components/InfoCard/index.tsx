import styles from './index.module.scss';

export default function InfoCard() {
  return (
    <div className={styles.card}>
      <h4 className={styles.title}>托管配置层级说明</h4>
      <ul className={styles.list}>
        <li>
          <strong>全局级别</strong>（本页面）：全局 AI 开关控制整个 Bot 的托管状态，关闭后所有消息都不会触发回复
        </li>
        <li>
          <strong>小组级别</strong>（本页面）：小组黑名单控制特定小组的托管状态，黑名单中的小组消息不触发回复
        </li>
        <li>
          <strong>用户级别</strong>（今日托管页面）：可在「今日托管」页面暂停单个用户的托管，精细控制个别用户
        </li>
      </ul>
      <div className={styles.tipBox}>
        💡 优先级：全局开关 &gt; 小组黑名单 &gt; 用户托管状态
      </div>
    </div>
  );
}
