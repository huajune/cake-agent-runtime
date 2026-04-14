import { useState, useEffect } from 'react';
import {
  useAgentReplyConfig,
  useUpdateAgentReplyConfig,
  useToggleMessageMerge,
  useAvailableModels,
} from '@/hooks/config/useSystemConfig';
import {
  useWorkerStatus,
  useSetWorkerConcurrency,
} from '@/hooks/config/useWorker';
import type { AgentReplyConfig } from '@/api/types/config.types';

// 组件导入
import ControlBar from './components/ControlBar';
import { NumberCard, BooleanCard, SelectCard, ConfigMeta } from './components/ConfigCard';
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
    label: '消息静默触发时间',
    description: '距离用户最后一条消息过去多久仍无新消息，就把这一轮消息聚合成一次 Agent 请求',
    unit: 'ms',
    min: 0,
    max: 30000,
    step: 100,
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
    description: '基于“最后一条消息后的静默窗口”触发新一轮 Agent 请求，避免复杂状态机带来的线上抖动',
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
  const { data: availableModelsData, isLoading: isLoadingModels } = useAvailableModels();

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
  const handleConfigChange = (key: string, value: number | boolean | string) => {
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
        title="运行时配置"
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
          <section className={styles.categorySection}>
            <div className={styles.categoryTitle}>模型配置</div>
            <div className={styles.cardGrid}>
              <SelectCard
                label="企微回调聊天模型"
                description="控制企业微信消息回调进入 Agent 时使用的聊天模型。留空时继续走默认角色路由（AGENT_CHAT_MODEL）。"
                fieldKey="wecomCallbackModelId"
                currentValue={String(editingConfig.wecomCallbackModelId ?? '')}
                defaultValue={agentConfigData?.defaults.wecomCallbackModelId ?? ''}
                options={availableModelsData?.availableModels ?? []}
                placeholder={
                  isLoadingModels ? '加载模型列表中...' : '默认角色路由（AGENT_CHAT_MODEL）'
                }
                onChange={handleConfigChange}
                disabled={isLoadingModels}
              />
            </div>
          </section>

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
