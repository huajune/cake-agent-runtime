import { Info, Lightbulb } from 'lucide-react';
import styles from './index.module.scss';

export default function InfoCard() {
  return (
    <div className={styles.card}>
      <h4 className={styles.title}>
        <Info size={15} strokeWidth={2} aria-hidden="true" />
        托管配置层级说明
      </h4>
      <ul className={styles.list}>
        <li>
          <strong>全局级别</strong>（本页面）：全局 AI 开关控制整个 Bot
          的托管状态，关闭后所有消息都不会触发回复
        </li>
        <li>
          <strong>小组级别</strong>
          （本页面）：小组黑名单控制特定小组的托管状态，黑名单中的小组消息不触发回复
        </li>
        <li>
          <strong>用户级别</strong>
          （托管用户页面）：可在「托管用户」页面暂停单个用户的托管，精细控制个别用户
        </li>
        <li>
          <strong>河南小组归属</strong>
          ：在托管平台的小组说明中，独占一行填写“河南自招团队成员”即可纳入河南范围，删除该行即可移出。河南团队仅能查看和操作本中心小组，总部可查看全部小组。
        </li>
        <li>
          <strong>归属更新</strong>
          ：小组归属信息缓存 5 分钟，修改后已打开的页面最迟约 5 分半钟同步；操作小组开关前会立即核验当前归属，无需等待缓存过期。
        </li>
      </ul>
      <div className={styles.tipBox}>
        <Lightbulb size={14} strokeWidth={2} aria-hidden="true" />
        优先级：全局开关 &gt; 小组黑名单 &gt; 用户托管状态
      </div>
    </div>
  );
}
