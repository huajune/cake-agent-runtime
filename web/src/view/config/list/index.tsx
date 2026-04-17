import { useEffect, useState } from 'react';
import {
  useAgentReplyConfig,
  useUpdateAgentReplyConfig,
  useToggleMessageMerge,
  useAvailableModels,
} from '@/hooks/config/useSystemConfig';
import { useWorkerStatus, useSetWorkerConcurrency } from '@/hooks/config/useWorker';
import { useMessageProcessingRecords } from '@/hooks/chat/useMessageProcessingRecords';
import type { AgentReplyConfig, AgentReplyThinkingMode } from '@/api/types/config.types';

import ControlBar from './components/ControlBar';
import { formatConfigValue } from './components/ConfigCard';
import WorkerPanel from './components/WorkerPanel';
import GroupTaskPanel from './components/GroupTaskPanel';

import styles from './styles/index.module.scss';

type NumberConfigKey = 'initialMergeWindowMs' | 'typingSpeedCharsPerSec' | 'paragraphGapMs';

interface NumberConfigMeta {
  key: NumberConfigKey;
  label: string;
  description: string;
  unit: string;
  min: number;
  max: number;
  step: number;
}

const numberConfigMeta: Record<NumberConfigKey, NumberConfigMeta> = {
  initialMergeWindowMs: {
    key: 'initialMergeWindowMs',
    label: '消息静默触发时间',
    description: '最后一条用户消息后静默多久，才把这一轮消息聚合成一次新的 Agent 请求。',
    unit: 'ms',
    min: 0,
    max: 30000,
    step: 100,
  },
  typingSpeedCharsPerSec: {
    key: 'typingSpeedCharsPerSec',
    label: '打字速度',
    description: '模拟真人回复速度，控制文本逐段发送时的整体节奏。',
    unit: '字符/秒',
    min: 1,
    max: 50,
    step: 1,
  },
  paragraphGapMs: {
    key: 'paragraphGapMs',
    label: '段落间隔',
    description: '多段回复之间的停顿时长，让长消息看起来更自然。',
    unit: 'ms',
    min: 0,
    max: 10000,
    step: 100,
  },
};

const thinkingModeOptions: Array<{ value: AgentReplyThinkingMode; label: string; hint: string }> = [
  {
    value: 'fast',
    label: '极速模式',
    hint: '优先响应速度，适合大多数常规咨询。',
  },
  {
    value: 'deep',
    label: '深度思考',
    hint: '优先推理质量，支持的模型会启用更强思考。',
  },
];

function getThinkingModeLabel(value?: string): string {
  return thinkingModeOptions.find((option) => option.value === value)?.label ?? '极速模式';
}

export default function Config() {
  const [editingConfig, setEditingConfig] = useState<Partial<AgentReplyConfig>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [editingConcurrency, setEditingConcurrency] = useState<number | null>(null);

  const { data: agentConfigData, isLoading: isLoadingConfig } = useAgentReplyConfig();
  const updateConfig = useUpdateAgentReplyConfig();
  const { data: availableModelsData, isLoading: isLoadingModels } = useAvailableModels();

  const { data: workerStatus, isLoading: isLoadingWorker } = useWorkerStatus();
  const setConcurrency = useSetWorkerConcurrency();
  const toggleMessageMerge = useToggleMessageMerge();
  const { data: recentMessageRecords } = useMessageProcessingRecords({
    status: 'success',
    limit: 50,
  });

  useEffect(() => {
    if (agentConfigData?.config) {
      setEditingConfig(agentConfigData.config);
      setHasChanges(false);
    }
  }, [agentConfigData]);

  const handleConfigChange = (key: string, value: number | boolean | string) => {
    setEditingConfig((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSaveConfig = () => {
    updateConfig.mutate(editingConfig, {
      onSuccess: () => {
        setHasChanges(false);
      },
    });
  };

  const handleCancelEdit = () => {
    if (agentConfigData?.config) {
      setEditingConfig(agentConfigData.config);
      setHasChanges(false);
    }
  };

  const handleApplyConcurrency = () => {
    if (editingConcurrency !== null) {
      setConcurrency.mutate(editingConcurrency, {
        onSuccess: () => setEditingConcurrency(null),
      });
    }
  };

  const getDefaultValue = <K extends keyof AgentReplyConfig>(key: K) =>
    agentConfigData?.defaults[key];

  const getCurrentValue = <K extends keyof AgentReplyConfig>(key: K) =>
    editingConfig[key] ?? agentConfigData?.defaults[key];

  const isModified = <K extends keyof AgentReplyConfig>(key: K) =>
    getCurrentValue(key) !== getDefaultValue(key);

  const renderNumberSetting = (meta: NumberConfigMeta, options?: { disabled?: boolean }) => {
    const currentValue = Number(getCurrentValue(meta.key) ?? 0);
    const defaultValue = Number(getDefaultValue(meta.key) ?? 0);
    const modified = isModified(meta.key);

    return (
      <div
        key={meta.key}
        className={`${styles.settingRow} ${modified ? styles.settingRowModified : ''}`}
      >
        <div className={styles.settingBody}>
          <div className={styles.settingHeading}>
            <span className={styles.settingLabel}>{meta.label}</span>
            {modified ? <span className={styles.modifiedBadge}>已修改</span> : null}
          </div>
          <p className={styles.settingDescription}>{meta.description}</p>
          <div className={styles.settingMeta}>
            <span>
              范围: {meta.min} - {meta.max} {meta.unit}
            </span>
            <span>默认: {formatConfigValue(meta.key, defaultValue)}</span>
          </div>
        </div>
        <div className={styles.controlBlock}>
          <span className={styles.controlValue}>{formatConfigValue(meta.key, currentValue)}</span>
          <div className={styles.sliderControl}>
            <input
              type="range"
              className={styles.slider}
              min={meta.min}
              max={meta.max}
              step={meta.step}
              value={currentValue}
              disabled={options?.disabled}
              onChange={(e) => handleConfigChange(meta.key, Number(e.target.value))}
            />
            <input
              type="number"
              className={styles.numberInput}
              min={meta.min}
              max={meta.max}
              step={meta.step}
              value={currentValue}
              disabled={options?.disabled}
              onChange={(e) => handleConfigChange(meta.key, Number(e.target.value))}
            />
          </div>
        </div>
      </div>
    );
  };

  const modelValue = String(getCurrentValue('wecomCallbackModelId') ?? '');
  const modelDefaultValue = String(getDefaultValue('wecomCallbackModelId') ?? '');
  const thinkingModeValue = String(
    getCurrentValue('wecomCallbackThinkingMode') ?? 'fast',
  ) as AgentReplyThinkingMode;
  const thinkingModeDefaultValue = String(
    getDefaultValue('wecomCallbackThinkingMode') ?? 'fast',
  ) as AgentReplyThinkingMode;
  const currentMergeWindow = Number(getCurrentValue('initialMergeWindowMs') ?? 0);
  const e2eSamples =
    recentMessageRecords?.filter(
      (record) => Number.isFinite(record.totalDuration) && record.totalDuration > 0,
    ) ?? [];
  const averageE2EMs =
    e2eSamples.length > 0
      ? e2eSamples.reduce((sum, record) => sum + record.totalDuration, 0) / e2eSamples.length
      : null;

  return (
    <div className={styles.page}>
      <ControlBar
        title="运行时配置"
        subtitle="统一管理企微回调模型、消息节奏和运行开关。这里只放真正影响当前系统运行方式的配置。"
        hints={[{ label: '表单项需要保存' }, { label: '运行开关即时生效' }]}
        hasChanges={hasChanges}
        isPending={updateConfig.isPending}
      />

      {isLoadingConfig ? (
        <div className={styles.loadingText}>加载配置中...</div>
      ) : (
        <>
          <section className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>Agent 回复</h3>
                <p className={styles.moduleDescription}>
                  这一组决定企微回调进 Agent 时使用哪个模型，以及消息发送时表现出来的回复节奏。
                </p>
              </div>
            </div>

            <div className={styles.settingsPanel}>
              <div
                className={`${styles.settingRow} ${isModified('wecomCallbackModelId') ? styles.settingRowModified : ''}`}
              >
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>企微回调聊天模型</span>
                    {isModified('wecomCallbackModelId') ? (
                      <span className={styles.modifiedBadge}>已修改</span>
                    ) : null}
                  </div>
                  <p className={styles.settingDescription}>
                    控制企业微信消息回调进入 Agent 时使用的聊天模型。留空时继续走默认角色路由。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>适用于新的企微回调请求</span>
                    <span>默认: {modelDefaultValue || '默认角色路由'}</span>
                  </div>
                </div>
                <div className={styles.controlBlock}>
                  <span className={styles.controlValue}>{modelValue || '默认角色路由'}</span>
                  <select
                    className={styles.selectInput}
                    value={modelValue}
                    onChange={(e) => handleConfigChange('wecomCallbackModelId', e.target.value)}
                    disabled={isLoadingModels}
                  >
                    <option value="">
                      {isLoadingModels ? '加载模型列表中...' : '默认角色路由（AGENT_CHAT_MODEL）'}
                    </option>
                    {(availableModelsData?.availableModels ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div
                className={`${styles.settingRow} ${isModified('wecomCallbackThinkingMode') ? styles.settingRowModified : ''}`}
              >
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>企微回调回复模式</span>
                    {isModified('wecomCallbackThinkingMode') ? (
                      <span className={styles.modifiedBadge}>已修改</span>
                    ) : null}
                  </div>
                  <p className={styles.settingDescription}>
                    控制企微回调进入 Agent
                    时更偏向极速回复，还是偏向深度推理。对不支持推理模式的模型，会自动忽略这项设置。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>适用于新的企微回调请求</span>
                    <span>默认: {getThinkingModeLabel(thinkingModeDefaultValue)}</span>
                  </div>
                </div>
                <div className={styles.controlBlock}>
                  <span className={styles.controlValue}>
                    {getThinkingModeLabel(thinkingModeValue)}
                  </span>
                  <select
                    className={styles.selectInput}
                    value={thinkingModeValue}
                    onChange={(e) =>
                      handleConfigChange(
                        'wecomCallbackThinkingMode',
                        e.target.value as AgentReplyThinkingMode,
                      )
                    }
                  >
                    {thinkingModeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} · {option.hint}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {renderNumberSetting(numberConfigMeta.typingSpeedCharsPerSec)}
              {renderNumberSetting(numberConfigMeta.paragraphGapMs)}
            </div>
          </section>

          <section className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>消息处理与调度</h3>
                <p className={styles.moduleDescription}>
                  用来控制消息何时触发一轮新请求，以及 Worker 如何消化这些请求。
                </p>
              </div>
            </div>

            <div className={styles.settingsPanel}>
              <div className={styles.settingRow}>
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>消息聚合</span>
                    <span
                      className={`${styles.statusBadge} ${
                        workerStatus?.messageMergeEnabled ? styles.statusOn : styles.statusOff
                      }`}
                    >
                      {workerStatus?.messageMergeEnabled ? '已启用' : '已关闭'}
                    </span>
                  </div>
                  <p className={styles.settingDescription}>
                    启用后，系统会等待短暂静默窗口再触发新请求，适合用户连续发多条消息的场景。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>该开关即时生效</span>
                    <span>
                      当前窗口: {formatConfigValue('initialMergeWindowMs', currentMergeWindow)}
                    </span>
                  </div>
                </div>
                <div className={styles.toggleControl}>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={workerStatus?.messageMergeEnabled ?? false}
                      disabled={toggleMessageMerge.isPending}
                      onChange={(e) => toggleMessageMerge.mutate(e.target.checked)}
                    />
                    <span className={styles.switchTrack}>
                      <span className={styles.switchThumb} />
                    </span>
                  </label>
                </div>
              </div>

              {renderNumberSetting(numberConfigMeta.initialMergeWindowMs, {
                disabled: !(workerStatus?.messageMergeEnabled ?? false),
              })}
            </div>

            <div className={styles.subPanel}>
              <WorkerPanel
                isLoading={isLoadingWorker}
                workerStatus={workerStatus}
                editingConcurrency={editingConcurrency}
                isPending={setConcurrency.isPending}
                averageE2EMs={averageE2EMs}
                e2eSampleCount={e2eSamples.length}
                onConcurrencyChange={setEditingConcurrency}
                onApply={handleApplyConcurrency}
                onCancel={() => setEditingConcurrency(null)}
              />
            </div>
          </section>

          <section className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>群任务通知</h3>
                <p className={styles.moduleDescription}>
                  管理 Cron 自动推送与手动触发入口。这里的开关都是即时生效，不需要额外保存。
                </p>
              </div>
            </div>

            <div className={styles.subPanel}>
              <GroupTaskPanel config={agentConfigData?.groupTaskConfig} />
            </div>
          </section>
        </>
      )}

      {hasChanges ? (
        <div className={styles.saveDock}>
          <div className={styles.saveDockInfo}>
            <span className={styles.saveDockTitle}>有未保存更改</span>
            <span className={styles.saveDockText}>
              当前页面里只有表单项需要保存，运行开关类配置已经即时生效。
            </span>
          </div>
          <div className={styles.saveDockActions}>
            <button className={styles.btnGhost} onClick={handleCancelEdit}>
              取消
            </button>
            <button
              className={styles.btnPrimary}
              onClick={handleSaveConfig}
              disabled={updateConfig.isPending}
            >
              {updateConfig.isPending ? '保存中...' : '保存更改'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
