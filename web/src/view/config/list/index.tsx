import { useEffect, useState } from 'react';
import {
  useAgentReplyConfig,
  useUpdateAgentReplyConfig,
  useToggleMessageMerge,
  useAvailableModels,
} from '@/hooks/config/useSystemConfig';
import { useWorkerStatus, useSetWorkerConcurrency } from '@/hooks/config/useWorker';
import { useReengagementScenarios } from '@/hooks/reengagement/useReengagementRecords';
import { useMessageProcessingRecords } from '@/hooks/chat/useMessageProcessingRecords';
import type { AgentReplyConfig, AgentReplyThinkingMode } from '@/api/types/config.types';
import type { ReengagementScenario } from '@/api/types/reengagement.types';

import { ModelSelector } from '@/components/ModelSelector';
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
  const modelOptions = availableModelsData?.models ?? [];
  const modelDefaultOption = modelOptions.find((o) => o.id === modelDefaultValue);
  const modelDefaultLabel = modelDefaultOption
    ? modelDefaultOption.name || modelDefaultOption.id
    : modelDefaultValue || '默认角色路由';
  const extractModelValue = String(getCurrentValue('extractModelId') ?? '');
  const extractModelDefaultValue = String(getDefaultValue('extractModelId') ?? '');
  const extractModelDefaultOption = modelOptions.find((o) => o.id === extractModelDefaultValue);
  const extractModelDefaultLabel = extractModelDefaultOption
    ? extractModelDefaultOption.name || extractModelDefaultOption.id
    : extractModelDefaultValue || '默认角色路由';
  const thinkingModeValue = String(
    getCurrentValue('wecomCallbackThinkingMode') ?? 'fast',
  ) as AgentReplyThinkingMode;
  const thinkingModeDefaultValue = String(
    getDefaultValue('wecomCallbackThinkingMode') ?? 'fast',
  ) as AgentReplyThinkingMode;
  const currentMergeWindow = Number(getCurrentValue('initialMergeWindowMs') ?? 0);
  // 出站守卫开关直接读服务端最新值（3s 轮询），不进 editingConfig 表单态——切换即保存
  const guardrailLlmEnabled = Boolean(agentConfigData?.config.outputGuardrailLlmEnabled);
  const guardrailShadowEnabled = Boolean(
    agentConfigData?.config.outputGuardrailSemanticShadowEnabled,
  );
  // 主动复聊开关同守卫开关：直接读服务端最新值，切换即保存
  const reengagementEnabled = Boolean(agentConfigData?.config.reengagementEnabled);
  const reengagementShadow = Boolean(agentConfigData?.config.reengagementShadow ?? true);
  const { data: reengagementScenarios } = useReengagementScenarios();
  const reengagementPostBookingEnabled = Boolean(
    agentConfigData?.config.reengagementPostBookingEnabled ?? true,
  );
  const scenarioRollout = agentConfigData?.config.reengagementScenarioRollout ?? {};

  // 场景开关：托管配置里配过用配置值，没配过回退代码默认值
  const isScenarioOn = (scenario: ReengagementScenario) =>
    scenarioRollout[scenario.code] ?? scenario.defaultRolloutEnabled;

  // 场景实际投递状态 = 场景开关 × 报名后大开关 × 总开关 × 演练模式 叠加
  const getScenarioStatus = (scenario: ReengagementScenario) => {
    if (!isScenarioOn(scenario)) return { label: '已关闭', className: styles.statusOff };
    if (scenario.phase === 'post_booking' && !reengagementPostBookingEnabled) {
      return { label: '报名后开关关闭', className: styles.statusWarn };
    }
    if (!reengagementEnabled) return { label: '待生效 · 总开关关闭', className: styles.statusWarn };
    if (reengagementShadow) return { label: '待生效 · 演练中', className: styles.statusWarn };
    return { label: '真实发送', className: styles.statusOn };
  };

  // 每次切换都回传完整 map：后端是浅合并，传增量会把其他场景的配置冲掉
  const toggleScenario = (code: string, next: boolean) => {
    updateConfig.mutate({
      reengagementScenarioRollout: { ...scenarioRollout, [code]: next },
    });
  };

  const preBookingScenarios = (reengagementScenarios ?? []).filter(
    (s) => s.phase === 'pre_booking',
  );
  const postBookingScenarios = (reengagementScenarios ?? []).filter(
    (s) => s.phase === 'post_booking',
  );

  const renderScenarioTable = (scenarios: ReengagementScenario[]) => (
    <div className={styles.scenarioTableWrap}>
      <table className={styles.scenarioTable}>
        <thead>
          <tr>
            <th>场景</th>
            <th>锚点事件</th>
            <th>触发延迟</th>
            <th>目的</th>
            <th>场景开关</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((scenario) => {
            const status = getScenarioStatus(scenario);
            return (
              <tr key={scenario.code}>
                <td>
                  <div className={styles.scenarioName}>{scenario.displayName}</div>
                  <div className={styles.scenarioCode}>{scenario.code}</div>
                </td>
                <td>
                  <div>{scenario.anchorLabel}</div>
                  <div className={styles.scenarioCode}>{scenario.anchorEvent}</div>
                </td>
                <td>{scenario.delayLabel}</td>
                <td className={styles.scenarioObjective}>{scenario.objective}</td>
                <td>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={isScenarioOn(scenario)}
                      disabled={updateConfig.isPending}
                      onChange={(e) => toggleScenario(scenario.code, e.target.checked)}
                    />
                    <span className={styles.switchTrack}>
                      <span className={styles.switchThumb} />
                    </span>
                  </label>
                </td>
                <td>
                  <span className={`${styles.statusBadge} ${status.className}`}>
                    {status.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
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
                    <span>默认: {modelDefaultLabel}</span>
                  </div>
                </div>
                <div className={styles.controlBlock}>
                  <ModelSelector
                    value={modelValue}
                    options={modelOptions}
                    onChange={(next) => handleConfigChange('wecomCallbackModelId', next)}
                    disabled={isLoadingModels}
                    placeholder={isLoadingModels ? '加载模型列表中...' : '默认角色路由'}
                    defaultOptionLabel="默认角色路由"
                    defaultOptionDesc="留空则走后端 AGENT_CHAT_MODEL 角色路由"
                  />
                </div>
              </div>

              <div
                className={`${styles.settingRow} ${isModified('extractModelId') ? styles.settingRowModified : ''}`}
              >
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>事实提取模型</span>
                    {isModified('extractModelId') ? (
                      <span className={styles.modifiedBadge}>已修改</span>
                    ) : null}
                  </div>
                  <p className={styles.settingDescription}>
                    控制会话事实提取与沉淀摘要使用的模型。留空时走后端 AGENT_EXTRACT_MODEL
                    角色路由。切换后请在系统监控页观察"提取质量对账"卡片，准确率下滑即回退。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>适用于新的提取/沉淀请求</span>
                    <span>默认: {extractModelDefaultLabel}</span>
                  </div>
                </div>
                <div className={styles.controlBlock}>
                  <ModelSelector
                    value={extractModelValue}
                    options={modelOptions}
                    onChange={(next) => handleConfigChange('extractModelId', next)}
                    disabled={isLoadingModels}
                    placeholder={isLoadingModels ? '加载模型列表中...' : '默认角色路由'}
                    defaultOptionLabel="默认角色路由"
                    defaultOptionDesc="留空则走后端 AGENT_EXTRACT_MODEL 角色路由"
                  />
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
                <h3 className={styles.moduleTitle}>出站守卫（LLM 语义审查）</h3>
                <p className={styles.moduleDescription}>
                  回复发出前的最后一道语义审查：核对岗位推荐、地理品牌、预约状态与工具证据是否一致。
                  开关即时生效，无需保存；灰度期先开
                  Shadow，判例达标后再开拦截，拦截出问题可随时在这里熔断。
                </p>
              </div>
            </div>

            <div className={styles.settingsPanel}>
              <div className={styles.settingRow}>
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>LLM 审查拦截（enforce）</span>
                    <span
                      className={`${styles.statusBadge} ${
                        guardrailLlmEnabled ? styles.statusOn : styles.statusOff
                      }`}
                    >
                      {guardrailLlmEnabled ? '已启用' : '已关闭'}
                    </span>
                  </div>
                  <p className={styles.settingDescription}>
                    开启后，语义审查的结论会真正参与出站裁决：高风险回复（已提交预约等副作用、含承诺性措辞）
                    会被打回重写或拦截不发。关闭时仅确定性规则档生效。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>该开关即时生效</span>
                    <span>审查故障时高风险回复按 fail-close 拦截</span>
                  </div>
                </div>
                <div className={styles.toggleControl}>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={guardrailLlmEnabled}
                      disabled={updateConfig.isPending}
                      onChange={(e) =>
                        updateConfig.mutate({ outputGuardrailLlmEnabled: e.target.checked })
                      }
                    />
                    <span className={styles.switchTrack}>
                      <span className={styles.switchThumb} />
                    </span>
                  </label>
                </div>
              </div>

              <div className={styles.settingRow}>
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>Shadow 观测</span>
                    <span
                      className={`${styles.statusBadge} ${
                        guardrailShadowEnabled && !guardrailLlmEnabled
                          ? styles.statusOn
                          : styles.statusOff
                      }`}
                    >
                      {guardrailLlmEnabled
                        ? '拦截开启时不生效'
                        : guardrailShadowEnabled
                          ? '观测中'
                          : '已关闭'}
                    </span>
                  </div>
                  <p className={styles.settingDescription}>
                    开启后，语义审查跟随真实流量试运行，结论只写入飞书 badcase
                    表和流水记录，不影响任何回复的发送。用于灰度期评估"如果它说了算，会拦哪些回复"。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>该开关即时生效</span>
                    <span>命中判例见飞书 badcase 多维表</span>
                  </div>
                </div>
                <div className={styles.toggleControl}>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={guardrailShadowEnabled}
                      disabled={updateConfig.isPending || guardrailLlmEnabled}
                      onChange={(e) =>
                        updateConfig.mutate({
                          outputGuardrailSemanticShadowEnabled: e.target.checked,
                        })
                      }
                    />
                    <span className={styles.switchTrack}>
                      <span className={styles.switchThumb} />
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </section>

          <section className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>主动复聊（跟进触达）</h3>
                <p className={styles.moduleDescription}>
                  候选人沉默后由 Agent
                  主动跟进：开场未回、报名未完成、面试提醒等场景到点生成跟进消息。
                  开关即时生效；灰度期先开演练模式看"本应发什么"，达标后再关演练真实发送。
                </p>
              </div>
            </div>

            <div className={styles.settingsPanel}>
              <div className={styles.settingRow}>
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>复聊排程（总开关）</span>
                    <span
                      className={`${styles.statusBadge} ${
                        reengagementEnabled ? styles.statusOn : styles.statusOff
                      }`}
                    >
                      {reengagementEnabled ? '已启用' : '已关闭'}
                    </span>
                  </div>
                  <p className={styles.settingDescription}>
                    开启后，锚点事件（候选人开场未回复、报名中断、面试临近等）会排程延时跟进任务。
                    关闭是急刹车：不再产生新任务，已排程的任务到点也会直接丢弃。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>该开关即时生效</span>
                    <span>频控 24h ≤ 2 条 · 仅 9-21 点投递</span>
                  </div>
                </div>
                <div className={styles.toggleControl}>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={reengagementEnabled}
                      disabled={updateConfig.isPending}
                      onChange={(e) =>
                        updateConfig.mutate({ reengagementEnabled: e.target.checked })
                      }
                    />
                    <span className={styles.switchTrack}>
                      <span className={styles.switchThumb} />
                    </span>
                  </label>
                </div>
              </div>

              <div className={styles.settingRow}>
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>演练模式（Shadow）</span>
                    <span
                      className={`${styles.statusBadge} ${
                        reengagementShadow ? styles.statusOn : styles.statusOff
                      }`}
                    >
                      {!reengagementEnabled
                        ? '排程未启用'
                        : reengagementShadow
                          ? '演练中（不发送）'
                          : '真实发送'}
                    </span>
                  </div>
                  <p className={styles.settingDescription}>
                    开启时，到点走完全部停止判断并生成跟进文案，但不发给候选人，只记录"本应发什么"。
                    关闭后，下方场景清单里开关打开的场景会真实发送，其余场景仍只记录。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>该开关即时生效</span>
                    <span>场景级灰度见下方场景清单，触达明细见「二次触发」页</span>
                  </div>
                </div>
                <div className={styles.toggleControl}>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={reengagementShadow}
                      disabled={updateConfig.isPending}
                      onChange={(e) =>
                        updateConfig.mutate({ reengagementShadow: e.target.checked })
                      }
                    />
                    <span className={styles.switchTrack}>
                      <span className={styles.switchThumb} />
                    </span>
                  </label>
                </div>
              </div>
            </div>

            <div className={styles.subPanel}>
              <div className={styles.scenarioPanel}>
                <div className={styles.scenarioPanelHeader}>
                  <span className={styles.settingLabel}>场景清单与场景级开关</span>
                  <span className={styles.scenarioPanelHint}>
                    开关即时生效 · 全部场景仅在 9-21 点投递
                  </span>
                </div>
                {reengagementScenarios && reengagementScenarios.length > 0 ? (
                  <>
                    <div className={styles.scenarioGroup}>
                      <div className={styles.scenarioGroupHeader}>
                        <div className={styles.scenarioGroupInfo}>
                          <span className={styles.scenarioGroupTitle}>报名前</span>
                          <span className={styles.scenarioPanelHint}>
                            从开场到收资的跟进场景，逐个场景独立开关
                          </span>
                        </div>
                      </div>
                      {renderScenarioTable(preBookingScenarios)}
                    </div>

                    <div className={styles.scenarioGroup}>
                      <div className={styles.scenarioGroupHeader}>
                        <div className={styles.scenarioGroupInfo}>
                          <span className={styles.scenarioGroupTitle}>报名后</span>
                          <span
                            className={`${styles.statusBadge} ${
                              reengagementPostBookingEnabled ? styles.statusOn : styles.statusOff
                            }`}
                          >
                            {reengagementPostBookingEnabled ? '大开关已开' : '大开关已关'}
                          </span>
                          <span className={styles.scenarioPanelHint}>
                            报名成功之后的跟进流程较复杂，这里的大开关可整体熔断（关闭后下方场景全部只记录不发送）
                          </span>
                        </div>
                        <label className={styles.switch}>
                          <input
                            type="checkbox"
                            checked={reengagementPostBookingEnabled}
                            disabled={updateConfig.isPending}
                            onChange={(e) =>
                              updateConfig.mutate({
                                reengagementPostBookingEnabled: e.target.checked,
                              })
                            }
                          />
                          <span className={styles.switchTrack}>
                            <span className={styles.switchThumb} />
                          </span>
                        </label>
                      </div>
                      {renderScenarioTable(postBookingScenarios)}
                    </div>

                    <p className={styles.scenarioFootnote}>
                      「真实发送」需同时满足：总开关开启 + 演练关闭 + 场景开关开启（报名后场景还需
                      报名后大开关开启）；其余组合到点只走判断与生成、记录「本应发什么」。
                      候选人已回话、会话已终态或场景条件不再成立时，到点任务会自动取消。
                    </p>
                  </>
                ) : (
                  <div className={styles.loadingText}>加载场景清单中...</div>
                )}
              </div>
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
