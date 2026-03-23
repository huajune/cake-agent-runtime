import { useState } from 'react';
import { Check, Loader2, AlertCircle, History } from 'lucide-react';
import { TabSwitch } from '@/components/TabSwitch';
import { useStrategyConfig } from '@/hooks/strategy/useStrategyConfig';
import { useSaveStatusStore } from '@/hooks/strategy/useSaveStatusStore';
import PersonaSection from './components/PersonaSection';
import StageGoalsSection from './components/StageGoalsSection';
import RedLinesSection from './components/RedLinesSection';
import RiskScenariosSection from './components/RiskScenariosSection';
import IndustrySkillsSection from './components/IndustrySkillsSection';
import { ChangelogModal } from './components/ChangelogModal';
import styles from './styles/index.module.scss';

type TabKey = 'persona' | 'stageGoals' | 'redLines' | 'riskScenarios' | 'industrySkills';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'persona', label: '人格设定' },
  { key: 'stageGoals', label: '阶段目标' },
  { key: 'industrySkills', label: '行业 Skills' },
  { key: 'redLines', label: '政策红线' },
  { key: 'riskScenarios', label: '风险场景' },
];

export default function Strategy() {
  const [activeTab, setActiveTab] = useState<TabKey>('persona');
  const [changelogOpen, setChangelogOpen] = useState(false);
  const { data: config, isLoading } = useStrategyConfig();
  const saveStatus = useSaveStatusStore((s) => s.status);

  const tabs = TABS;

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.skeletonHeader}>
          <div className={styles.skeletonTabs}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className={styles.skeletonTab} />
            ))}
          </div>
        </div>
        <div className={styles.skeletonPanel}>
          <div className={styles.skeletonHeading} />
          <div className={styles.skeletonDesc} />
          {[1, 2, 3].map((i) => (
            <div key={i} className={styles.skeletonField}>
              <div className={styles.skeletonLabel} />
              <div className={styles.skeletonTextarea} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <h1 className={styles.headerTitle}>策略配置</h1>
          <div className={styles.headerActions}>
            {saveStatus !== 'idle' && (
              <div className={styles.saveStatus} data-status={saveStatus}>
                {saveStatus === 'saving' && <><Loader2 size={14} className={styles.spinIcon} /> 保存中...</>}
                {saveStatus === 'saved' && <><Check size={14} /> 已保存</>}
                {saveStatus === 'error' && <><AlertCircle size={14} /> 保存失败</>}
              </div>
            )}
            <button className={styles.changelogBtn} onClick={() => setChangelogOpen(true)}>
              <History size={14} />
              变更记录
            </button>
          </div>
        </div>
        <div className={styles.headerBottom}>
          <TabSwitch tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </div>

      {config && (
        <>
          {activeTab === 'persona' && <PersonaSection config={config} />}
          {activeTab === 'stageGoals' && <StageGoalsSection config={config} />}
          {activeTab === 'redLines' && <RedLinesSection config={config} />}
          {activeTab === 'riskScenarios' && <RiskScenariosSection config={config} />}
          {activeTab === 'industrySkills' && <IndustrySkillsSection />}
        </>
      )}

      <ChangelogModal isOpen={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </div>
  );
}
