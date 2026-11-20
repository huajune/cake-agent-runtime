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
          <strong>全局开关</strong>由管理员 cakeadmin 管理，关闭后会暂停所有小组的 AI 回复。
        </li>
        <li>
          <strong>小组开关</strong>在展开的小组列表中操作，只影响对应的小组。
        </li>
        <li>
          <strong>单个用户的托管</strong>可由总部在「托管用户」页面暂停。
        </li>
        <li>
          <strong>组织归属</strong>由管理员在「账号管理」绑定托管小组。组内新加入的企微号会随 Stride
          目录同步。换组的账号由管理员确认交接时间。
        </li>
      </ul>
      <div className={styles.tipBox}>
        <Lightbulb size={14} strokeWidth={2} aria-hidden="true" />
        优先级：全局开关 &gt; 小组黑名单 &gt; 用户托管状态
      </div>
    </div>
  );
}
