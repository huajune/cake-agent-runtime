import { useState, useEffect } from 'react';
import {
  useAgentReplyConfig,
  useUpdateAgentReplyConfig,
  useToggleMessageMerge,
} from '@/hooks/config/useSystemConfig';
import {
  useWorkerStatus,
  useSetWorkerConcurrency,
} from '@/hooks/config/useWorker';
import type { AgentReplyConfig } from '@/api/types/config.types';

// 组件导入
import ControlBar from './components/ControlBar';
import { NumberCard, BooleanCard, ConfigMeta } from './components/ConfigCard';
import WorkerPanel from './components/WorkerPanel';
import GroupTaskPanel from './components/GroupTaskPanel';

// 样式导入
import styles from './styles/index.module.scss';

// 配置项元数据
type ConfigKey = keyof AgentReplyConfig;

const configMeta: ConfigMeta[] = [
  // 消息聚合配置
  {
    key: 'initialMergeWindowMs',
    label: '消息聚合等待时间',
    description: '收到第一条消息后等待多久再处理（聚合连续消息）',
    unit: 'ms',
    min: 0,
    max: 30000,
    step: 100,
    category: 'merge',
    type: 'number',
  },
  {
    key: 'maxMergedMessages',
    label: '最大聚合消息数',
    description: '单次最多聚合多少条消息',
    unit: '条',
    min: 1,
    max: 10,
    step: 1,
    category: 'merge',
    type: 'number',
  },
  // 打字延迟配置
  {
    key: 'typingSpeedCharsPerSec',
    label: '打字速度',
    description: '模拟真人打字速度（字符/秒）',
    unit: '字符/秒',
    min: 1,
    max: 50,
    step: 1,
    category: 'typing',
    type: 'number',
  },
  {
    key: 'paragraphGapMs',
    label: '段落间隔延迟',
    description: '发送多段回复时，段落之间的停顿时间',
    unit: 'ms',
    min: 0,
    max: 10000,
    step: 100,
    category: 'typing',
    type: 'number',
  },
];

// 分类标题
const categoryTitles: Record<string, { title: string; description: string }> = {
  merge: {
    title: '消息聚合',
    description: '配置连续消息的合并策略，适合处理用户快速发送多条消息的场景',
  },
  typing: {
    title: '打字延迟',
    description: '模拟真人打字效果，让回复更自然',
  },
};

export default function Config() {
  // 本地编辑状态
  const [editingConfig, setEditingConfig] = useState<Partial<AgentReplyConfig>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState<number | null>(null);

  // Agent 回复策略配置
  const { data: agentConfigData, isLoading: isLoadingConfig } = useAgentReplyConfig();
  const updateConfig = useUpdateAgentReplyConfig();

  // Worker 状态
  const { data: workerStatus, isLoading: isLoadingWorker } = useWorkerStatus();
  const setConcurrency = useSetWorkerConcurrency();
  const toggleMessageMerge = useToggleMessageMerge();

  // 当配置数据加载后，初始化编辑状态
  useEffect(() => {
    if (agentConfigData?.config) {
      setEditingConfig(agentConfigData.config);
      setHasChanges(false);
    }
  }, [agentConfigData]);

  // 更新配置
  const handleConfigChange = (key: string, value: number | boolean) => {
    setEditingConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  // 保存配置
  const handleSaveConfig = () => {
    updateConfig.mutate(editingConfig, {
      onSuccess: () => {
        setHasChanges(false);
      },
    });
  };

  // 取消编辑
  const handleCancelEdit = () => {
    if (agentConfigData?.config) {
      setEditingConfig(agentConfigData.config);
      setHasChanges(false);
    }
  };

  // Worker 并发数应用
  const handleApplyConcurrency = () => {
    if (editingConcurrency !== null) {
      setConcurrency.mutate(editingConcurrency, {
        onSuccess: () => setEditingConcurrency(null),
      });
    }
  };

  return (
    <div className={styles.page}>
      {/* 顶部控制栏 */}
      <ControlBar
        title="通知/消息配置"
        icon="⚙️"
        hasChanges={hasChanges}
        isPending={updateConfig.isPending}
        onSave={handleSaveConfig}
        onCancel={handleCancelEdit}
      />

      {isLoadingConfig ? (
        <div className={styles.loadingText}>加载配置中...</div>
      ) : (
        <>
          {/* 群任务通知 */}
          <section className={styles.categorySection}>
            <div className={styles.categoryTitle}>群任务通知</div>
            <GroupTaskPanel config={agentConfigData?.groupTaskConfig} />
          </section>
          {/* 所有配置项平铺 */}
          {(['merge', 'typing'] as const).map((category) => {
            const categoryItems = configMeta.filter((m) => m.category === category);
            if (categoryItems.length === 0) return null;
            const { title } = categoryTitles[category];

            return (
              <section key={category} className={styles.categorySection}>
                <div className={styles.categoryTitle}>{title}</div>
                <div className={styles.cardGrid}>
                  {categoryItems.map((meta) => {
                    const currentValue =
                      (editingConfig[meta.key as ConfigKey] as number | boolean) ??
                      (agentConfigData?.defaults[meta.key as ConfigKey] as number | boolean);
                    const defaultValue = agentConfigData?.defaults[meta.key as ConfigKey] as number | boolean;

                    if (meta.type === 'boolean') {
                      return (
                        <BooleanCard
                          key={meta.key}
                          meta={meta}
                          currentValue={Boolean(currentValue)}
                          defaultValue={Boolean(defaultValue)}
                          onChange={handleConfigChange}
                        />
                      );
                    }
                    return (
                      <NumberCard
                        key={meta.key}
                        meta={meta}
                        currentValue={Number(currentValue || 0)}
                        defaultValue={Number(defaultValue || 0)}
                        onChange={handleConfigChange}
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}

          {/* Worker 并发配置 */}
          <section className={styles.categorySection}>
            <div className={styles.categoryTitle}>处理能力</div>
            <WorkerPanel
              isLoading={isLoadingWorker}
              workerStatus={workerStatus}
              editingConcurrency={editingConcurrency}
              isPending={setConcurrency.isPending}
              isTogglingMerge={toggleMessageMerge.isPending}
              onConcurrencyChange={setEditingConcurrency}
              onApply={handleApplyConcurrency}
              onCancel={() => setEditingConcurrency(null)}
              onToggleMessageMerge={(enabled) => toggleMessageMerge.mutate(enabled)}
            />
          </section>
        </>
      )}
    </div>
  );
}
