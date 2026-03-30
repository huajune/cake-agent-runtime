import { useState } from 'react';
import { Check, Loader2, AlertCircle, Upload, Info } from 'lucide-react';
import { TabSwitch } from '@/components/TabSwitch';
import {
  useStrategyConfig,
  useReleasedConfig,
  usePublishStrategy,
} from '@/hooks/strategy/useStrategyConfig';
import { useSaveStatusStore } from '@/hooks/strategy/useSaveStatusStore';
import PersonaSection from './components/PersonaSection';
import StageGoalsSection from './components/StageGoalsSection';
import RedLinesSection from './components/RedLinesSection';
import ThresholdsSection from './components/ThresholdsSection';
import IndustrySkillsSection from './components/IndustrySkillsSection';
import styles from './styles/index.module.scss';

type TabKey = 'persona' | 'stageGoals' | 'redLines' | 'thresholds' | 'industrySkills';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'persona', label: '人格设定' },
  { key: 'stageGoals', label: '阶段目标' },
  { key: 'industrySkills', label: '行业 Skills' },
  { key: 'redLines', label: '政策红线' },
  { key: 'thresholds', label: '业务阈值' },
];

export default function Strategy() {
  const [activeTab, setActiveTab] = useState<TabKey>('persona');
  const [publishConfirm, setPublishConfirm] = useState(false);
  const { data: config, isLoading } = useStrategyConfig();
  const { data: releasedConfig } = useReleasedConfig();
  const publishMutation = usePublishStrategy();
  const saveStatus = useSaveStatusStore((s) => s.status);

  const handlePublish = () => {
    if (!publishConfirm) {
      setPublishConfirm(true);
      setTimeout(() => setPublishConfirm(false), 3000);
      return;
    }
    publishMutation.mutate(undefined);
    setPublishConfirm(false);
  };

  const releasedVersion = releasedConfig?.version ?? 0;
  const releasedTime = releasedConfig?.released_at
    ? new Date(releasedConfig.released_at).toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

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
                {saveStatus === 'saving' && (
                  <>
                    <Loader2 size={14} className={styles.spinIcon} /> 保存中...
                  </>
                )}
                {saveStatus === 'saved' && (
                  <>
                    <Check size={14} /> 已保存
                  </>
                )}
                {saveStatus === 'error' && (
                  <>
                    <AlertCircle size={14} /> 保存失败
                  </>
                )}
              </div>
            )}
            <button
              className={
                publishConfirm ? styles.publishBtnConfirm : styles.publishBtn
              }
              onClick={handlePublish}
              disabled={publishMutation.isPending}
            >
              {publishMutation.isPending ? (
                <>
                  <Loader2 size={14} className={styles.spinIcon} /> 发布中...
                </>
              ) : publishConfirm ? (
                '确认发布?'
              ) : (
                <>
                  <Upload size={14} /> 发布策略
                </>
              )}
            </button>
          </div>
        </div>

        <div className={styles.versionBar}>
          <Info size={13} />
          <span>
            编辑中为测试版本，企微用户不受影响
            {releasedTime && (
              <span className={styles.versionInfo}>
                {' '}
                · 当前线上版本: v{releasedVersion} ({releasedTime})
              </span>
            )}
          </span>
        </div>

        <div className={styles.headerBottom}>
          <TabSwitch tabs={TABS} activeTab={activeTab} onTabChange={setActiveTab} />
        </div>
      </div>

      {config && (
        <>
          {activeTab === 'persona' && <PersonaSection config={config} />}
          {activeTab === 'stageGoals' && <StageGoalsSection config={config} />}
          {activeTab === 'redLines' && <RedLinesSection config={config} />}
          {activeTab === 'thresholds' && <ThresholdsSection config={config} />}
          {activeTab === 'industrySkills' && <IndustrySkillsSection />}
        </>
      )}
    </div>
  );
}
