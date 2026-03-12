import { Wrench } from 'lucide-react';
import styles from '../styles/index.module.scss';

export default function IndustrySkillsSection() {
  return (
    <div className={styles.panel}>
      <div className={styles.placeholder}>
        <div className={styles.placeholderIcon}>
          <Wrench size={32} />
        </div>
        <div className={styles.placeholderTitle}>功能开发中</div>
        <div className={styles.placeholderDesc}>
          行业 Skill 将以技能包形式提供给 AI 使用，敬请期待
        </div>
      </div>
    </div>
  );
}
