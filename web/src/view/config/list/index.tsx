import { useCallback, useEffect, useState } from 'react';
import {
  useAgentReplyConfig,
  useUpdateAgentReplyConfig,
  useToggleMessageMerge,
  useAvailableModels,
} from '@/hooks/config/useSystemConfig';
import { useWorkerStatus, useSetWorkerConcurrency } from '@/hooks/config/useWorker';
import { useReengagementScenarios } from '@/hooks/reengagement/useReengagementRecords';
import { useMessageProcessingRecords } from '@/hooks/chat/useMessageProcessingRecords';
import type {
  AgentModelConfigKey,
  AgentReplyConfig,
  AgentReplyThinkingMode,
} from '@/api/types/config.types';
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

/** 功能模块运行状态三态：关闭 → Shadow 观测（只记录）→ 真实生效 */
type ModuleRunState = 'off' | 'shadow' | 'live';

/** 页内分区：mode 标注该区配置的生效方式，驱动节标题徽章与锚点导航 */
type SectionMode = 'save' | 'instant' | 'mixed';

interface PageSection {
  id: string;
  label: string;
  mode: SectionMode;
}

const PAGE_SECTIONS: PageSection[] = [
  { id: 'models', label: '模型路由', mode: 'save' },
  { id: 'reply', label: '回复节奏', mode: 'save' },
  { id: 'dispatch', label: '消息调度', mode: 'mixed' },
  { id: 'guardrail', label: '出站守卫', mode: 'instant' },
  { id: 'reengagement', label: '主动复聊', mode: 'instant' },
  { id: 'grouptask', label: '群任务', mode: 'instant' },
];

const SECTION_MODE_LABELS: Record<SectionMode, string> = {
  save: '需保存',
  instant: '即时生效',
  mixed: '开关即时 · 滑杆需保存',
};

export default function Config() {
  const [editingConfig, setEditingConfig] = useState<Partial<AgentReplyConfig>>({});
  const [dirtyFields, setDirtyFields] = useState<string[]>([]);
  const [editingConcurrency, setEditingConcurrency] = useState<number | null>(null);
  // 场景清单属于低频配置，默认折叠，主开关操作路径保持清爽
  const [scenariosExpanded, setScenariosExpanded] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(PAGE_SECTIONS[0].id);

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
      setDirtyFields([]);
    }
  }, [agentConfigData]);

  // 锚点导航 scroll-spy：以视口上 1/4 带为命中区，滚动时高亮当前分区
  useEffect(() => {
    if (isLoadingConfig) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) {
          setActiveSection(visible[0].target.id.replace('config-', ''));
        }
      },
      { rootMargin: '-15% 0px -65% 0px' },
    );
    for (const section of PAGE_SECTIONS) {
      const el = document.getElementById(`config-${section.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [isLoadingConfig]);

  // 不用 scrollIntoView（overflow 祖先下会滚错容器）也不用 smooth（实测动画会被
  // 页面内其他滚动调用打断回弹）：显式对文档滚动容器瞬时定位最可靠；72px 为
  // sticky 导航条预留。
  const scrollToSection = (id: string) => {
    const el = document.getElementById(`config-${id}`);
    const scroller = document.scrollingElement;
    if (!el || !scroller) return;
    const top = scroller.scrollTop + el.getBoundingClientRect().top - 72;
    scroller.scrollTop = Math.max(top, 0);
    setActiveSection(id);
  };

  const renderSectionModeBadge = (mode: SectionMode) => (
    <span
      className={`${styles.sectionModeBadge} ${
        mode === 'instant'
          ? styles.sectionModeInstant
          : mode === 'save'
            ? styles.sectionModeSave
            : styles.sectionModeMixed
      }`}
    >
      {SECTION_MODE_LABELS[mode]}
    </span>
  );

  const handleConfigChange = (key: string, value: number | boolean | string) => {
    setEditingConfig((prev) => ({ ...prev, [key]: value }));
    setDirtyFields((prev) => {
      const persistedValue = agentConfigData?.config[key as keyof AgentReplyConfig];
      if (value === persistedValue) return prev.filter((field) => field !== key);
      return prev.includes(key) ? prev : [...prev, key];
    });
  };

  const handleSaveConfig = useCallback(() => {
    updateConfig.mutate(editingConfig, {
      onSuccess: () => setDirtyFields([]),
    });
  }, [editingConfig, updateConfig]);

  const handleCancelEdit = () => {
    if (agentConfigData?.config) {
      setEditingConfig(agentConfigData.config);
      setDirtyFields([]);
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

  const pendingChangeCount = dirtyFields.length;
  const hasChanges = pendingChangeCount > 0;

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (hasChanges && !updateConfig.isPending) handleSaveConfig();
    };

    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [handleSaveConfig, hasChanges, updateConfig.isPending]);

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
            {modified ? <span className={styles.modifiedBadge}>覆盖默认</span> : null}
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

  const modelOptions = availableModelsData?.models ?? [];

  // 七个角色统一走同一套模型覆盖机制（agent_reply_config），列表紧凑渲染。
  // 留空 = 走对应 AGENT_{ROLE}_MODEL 环境变量角色路由。
  const modelRoleFields: Array<{
    key: AgentModelConfigKey;
    label: string;
    envVar: string;
    hint: string;
  }> = [
    {
      key: 'wecomCallbackModelId',
      label: '企微聊天',
      envVar: 'AGENT_CHAT_MODEL',
      hint: '企微回调进 Agent 的主对话模型，直接决定候选人体验。',
    },
    {
      key: 'extractModelId',
      label: '事实提取',
      envVar: 'AGENT_EXTRACT_MODEL',
      hint: '会话事实提取与沉淀摘要。切换后盯系统监控页「提取质量对账」。',
    },
    {
      key: 'visionModelId',
      label: '图片理解',
      envVar: 'AGENT_VISION_MODEL',
      hint: '健康证、岗位截图等图片消息的视觉理解，仅可选多模态模型。',
    },
    {
      key: 'evaluateModelId',
      label: '对话质量评估',
      envVar: 'AGENT_EVALUATE_MODEL',
      hint: '对话质量 LLM 评分。切换后评估分数环比会出现口径断点。',
    },
    {
      key: 'reviewModelId',
      label: '守卫语义审查',
      envVar: 'AGENT_REVIEW_MODEL',
      hint: '出站语义审查，建议与聊天模型跨厂商；切换后 shadow 精度需重新基线。',
    },
    {
      key: 'repairModelId',
      label: '守卫修复',
      envVar: 'AGENT_REPAIR_MODEL',
      hint: '守卫拦截后的回复改写（revise 修复）。',
    },
    {
      key: 'reengagementModelId',
      label: '复聊',
      envVar: 'AGENT_REENGAGEMENT_MODEL',
      hint: '复聊触达的语义停止判定与文案生成，判定质量对模型敏感；留空回退环境变量，再回退企微聊天角色。',
    },
  ];

  const renderModelCell = (field: (typeof modelRoleFields)[number]) => {
    const value = String(getCurrentValue(field.key) ?? '');
    const resolvedModel = agentConfigData?.resolvedModels?.[field.key];
    // 兼容前端先于后端发布：已有页面覆盖值本身就是当前生效模型。
    const effectiveModelId = resolvedModel?.modelId || value;
    return (
      <div
        key={field.key}
        className={`${styles.modelCell} ${isModified(field.key) ? styles.modelCellModified : ''}`}
      >
        <div className={styles.modelCellIdentity}>
          <div className={styles.settingHeading}>
            <span className={styles.settingLabel}>{field.label}</span>
            {isModified(field.key) ? (
              <span className={styles.modifiedBadge}>覆盖默认</span>
            ) : null}
          </div>
          <p className={styles.modelCellHint} title={field.hint}>
            {field.hint}
          </p>
        </div>
        <div className={styles.modelCellControl}>
          <ModelSelector
            value={value}
            options={modelOptions}
            onChange={(next) => handleConfigChange(field.key, next)}
            disabled={isLoadingModels}
            placeholder={isLoadingModels ? '加载模型列表中...' : '默认角色路由'}
            defaultOptionLabel="默认角色路由"
            defaultOptionDesc={
              effectiveModelId
                ? `当前使用 ${effectiveModelId}`
                : `留空则走后端 ${field.envVar} 角色路由`
            }
            resolvedDefaultLabel={
              !value && effectiveModelId ? `${effectiveModelId} · 默认路由` : undefined
            }
            showModelId={false}
            triggerDisplay="id"
          />
        </div>
      </div>
    );
  };
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
  const scenarioDelayMinutes = agentConfigData?.config.reengagementScenarioDelayMinutes ?? {};

  // 场景开关：托管配置里配过用配置值，没配过回退代码默认值
  const isScenarioOn = (scenario: ReengagementScenario) =>
    scenarioRollout[scenario.code] ?? scenario.defaultRolloutEnabled;

  // 场景实际投递状态 = 场景开关 × 报名后大开关 × 总开关 × Shadow 观测 叠加
  const getScenarioStatus = (scenario: ReengagementScenario) => {
    if (!isScenarioOn(scenario)) return { label: '已关闭', className: styles.statusOff };
    if (scenario.phase === 'post_booking' && !reengagementPostBookingEnabled) {
      return { label: '报名后开关关闭', className: styles.statusWarn };
    }
    if (!reengagementEnabled) return { label: '待生效 · 总开关关闭', className: styles.statusWarn };
    if (reengagementShadow)
      return { label: '待生效 · Shadow 观测中', className: styles.statusWarn };
    return { label: '真实发送', className: styles.statusOn };
  };

  // 只传本次切换的增量：后端对 scenarioRollout 按 key 合并。回传整表反而危险——
  // 本地快照可能过期（后台标签页暂停轮询/查询失败兜底 {}），整表覆盖会把
  // 其他场景的紧急停用配置静默冲掉。
  const toggleScenario = (code: string, next: boolean) => {
    updateConfig.mutate({
      reengagementScenarioRollout: { [code]: next },
    });
  };

  const updateScenarioDelay = (scenario: ReengagementScenario, raw: string) => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_080) return;
    updateConfig.mutate({ reengagementScenarioDelayMinutes: { [scenario.code]: parsed } });
  };

  const delaySuffix = (scenario: ReengagementScenario) =>
    scenario.delayMode === 'before_interview'
      ? '分钟前'
      : scenario.delayMode === 'after_interview'
        ? '分钟后'
        : '分钟后';

  // ===== 三态运行状态：两个布尔开关（总开关 × shadow）收敛成 关闭/Shadow 观测/生效 =====
  const guardrailState: ModuleRunState = guardrailLlmEnabled
    ? 'live'
    : guardrailShadowEnabled
      ? 'shadow'
      : 'off';
  const setGuardrailState = (next: ModuleRunState) => {
    if (next === 'off') {
      updateConfig.mutate({
        outputGuardrailLlmEnabled: false,
        outputGuardrailSemanticShadowEnabled: false,
      });
    } else if (next === 'shadow') {
      updateConfig.mutate({
        outputGuardrailLlmEnabled: false,
        outputGuardrailSemanticShadowEnabled: true,
      });
    } else {
      updateConfig.mutate({ outputGuardrailLlmEnabled: true });
    }
  };

  const reengagementState: ModuleRunState = !reengagementEnabled
    ? 'off'
    : reengagementShadow
      ? 'shadow'
      : 'live';
  const setReengagementState = (next: ModuleRunState) => {
    if (next === 'off') {
      // 关闭时把 shadow 复位为 true：否则从 live 关掉后留下 shadow=false，
      // 将来任何绕过本页的重新启用（脚本/裸 PATCH）会直接跳到真实触达
      updateConfig.mutate({ reengagementEnabled: false, reengagementShadow: true });
    } else if (next === 'shadow') {
      updateConfig.mutate({ reengagementEnabled: true, reengagementShadow: true });
    } else {
      updateConfig.mutate({ reengagementEnabled: true, reengagementShadow: false });
    }
  };

  const renderRunStateControl = (
    current: ModuleRunState,
    onSelect: (next: ModuleRunState) => void,
    labels: Record<ModuleRunState, string>,
  ) => (
    <div className={styles.segmented} role="radiogroup">
      {(['off', 'shadow', 'live'] as const).map((value) => {
        const active = current === value;
        const activeClass =
          value === 'off'
            ? styles.segmentedActiveOff
            : value === 'shadow'
              ? styles.segmentedActiveWarn
              : styles.segmentedActiveOn;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${styles.segmentedOption} ${active ? `${styles.segmentedActive} ${activeClass}` : ''}`}
            disabled={updateConfig.isPending}
            onClick={() => {
              if (!active) onSelect(value);
            }}
          >
            {labels[value]}
          </button>
        );
      })}
    </div>
  );

  const scenarioOnCount = (reengagementScenarios ?? []).filter(isScenarioOn).length;

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
                <td>
                  <div className={styles.delayEditor}>
                    <input
                      key={`${scenario.code}-${scenarioDelayMinutes[scenario.code] ?? scenario.defaultDelayMinutes}`}
                      className={styles.delayInput}
                      type="number"
                      min={0}
                      max={10_080}
                      step={1}
                      defaultValue={
                        scenarioDelayMinutes[scenario.code] ?? scenario.defaultDelayMinutes
                      }
                      disabled={updateConfig.isPending}
                      aria-label={`${scenario.displayName}触发偏移分钟数`}
                      onBlur={(e) => updateScenarioDelay(scenario, e.target.value)}
                    />
                    <span>{delaySuffix(scenario)}</span>
                  </div>
                  <div className={styles.scenarioCode}>默认：{scenario.delayLabel}</div>
                </td>
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
        pendingChangeCount={pendingChangeCount}
        isPending={updateConfig.isPending}
      />

      {isLoadingConfig ? (
        <div className={styles.loadingText}>加载配置中...</div>
      ) : (
        <>
          <nav className={styles.sectionNav} aria-label="页内分区导航">
            {PAGE_SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`${styles.sectionNavItem} ${
                  activeSection === section.id ? styles.sectionNavItemActive : ''
                }`}
                onClick={() => scrollToSection(section.id)}
              >
                <span className={styles.sectionNavLabel}>{section.label}</span>
                <span className={styles.sectionNavMeta}>{SECTION_MODE_LABELS[section.mode]}</span>
              </button>
            ))}
          </nav>

          <section id="config-models" className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>
                  模型路由
                  {renderSectionModeBadge('save')}
                </h3>
                <p className={styles.moduleDescription}>
                  七个 Agent 角色各用哪个模型。留空走后端环境变量的默认路由，改动保存后约 5
                  秒内全实例生效，无需发版。
                </p>
              </div>
            </div>

            <div className={styles.settingsPanel}>
              <div className={styles.modelListHeader} aria-hidden="true">
                <span>角色与用途</span>
                <span>模型</span>
              </div>
              <div className={styles.modelGrid}>{modelRoleFields.map(renderModelCell)}</div>
            </div>
          </section>

          <section id="config-reply" className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>
                  回复节奏
                  {renderSectionModeBadge('save')}
                </h3>
                <p className={styles.moduleDescription}>
                  决定回复偏速度还是偏推理，以及消息发出时表现出来的拟人节奏。
                </p>
              </div>
            </div>

            <div className={styles.settingsPanel}>
              <div
                className={`${styles.settingRow} ${isModified('wecomCallbackThinkingMode') ? styles.settingRowModified : ''}`}
              >
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>企微回调回复模式</span>
                    {isModified('wecomCallbackThinkingMode') ? (
                      <span className={styles.modifiedBadge}>覆盖默认</span>
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

          <section id="config-dispatch" className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>
                  消息处理与调度
                  {renderSectionModeBadge('mixed')}
                </h3>
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

          <section id="config-guardrail" className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>
                  出站守卫（LLM 语义审查）
                  {renderSectionModeBadge('instant')}
                </h3>
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
                    <span className={styles.settingLabel}>运行状态</span>
                  </div>
                  <p className={styles.settingDescription}>
                    <strong>关闭</strong>：仅确定性规则档生效，语义审查不运行。
                    <strong>Shadow 观测</strong>：审查跟随真实流量试跑，结论写入守卫日志和
                    执行事件，不影响发送，用于评估"如果它说了算，会拦哪些回复"。
                    <strong>拦截生效</strong>
                    ：审查结论真正参与出站裁决，高风险回复（已提交预约等副作用、含承诺性措辞）会被打回重写或拦截不发。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>切换即时生效</span>
                    <span>拦截生效时审查故障按 fail-close 拦截</span>
                    <span>完整判例见守卫日志，运行统计见执行事件</span>
                  </div>
                </div>
                <div className={styles.controlBlock}>
                  {renderRunStateControl(guardrailState, setGuardrailState, {
                    off: '关闭',
                    shadow: 'Shadow 观测',
                    live: '拦截生效',
                  })}
                </div>
              </div>
            </div>
          </section>

          <section id="config-reengagement" className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>
                  主动复聊（跟进触达）
                  {renderSectionModeBadge('instant')}
                </h3>
                <p className={styles.moduleDescription}>
                  候选人沉默后由 Agent
                  主动跟进：开场未回、报名未完成、面试提醒等场景到点生成跟进消息。
                  开关即时生效；灰度期先开 Shadow 观测看"本应发什么"，达标后再切真实发送。
                </p>
              </div>
            </div>

            <div className={styles.settingsPanel}>
              <div className={styles.settingRow}>
                <div className={styles.settingBody}>
                  <div className={styles.settingHeading}>
                    <span className={styles.settingLabel}>运行状态</span>
                  </div>
                  <p className={styles.settingDescription}>
                    <strong>关闭</strong>
                    ：急刹车，不再排程新跟进任务，已排程的任务到点也直接丢弃。
                    <strong>Shadow 观测</strong>：锚点事件正常排程，到点走完停止判断并生成跟进文案，
                    但不发给候选人，只记录"本应发什么"。
                    <strong>真实发送</strong>
                    ：下方场景清单里开关打开的场景会真正发送，其余场景仍只记录。
                  </p>
                  <div className={styles.settingMeta}>
                    <span>切换即时生效</span>
                    <span>频控 24h ≤ 2 条 · 仅 9-21 点投递</span>
                    <span>触达明细见「二次触发」页</span>
                  </div>
                </div>
                <div className={styles.controlBlock}>
                  {renderRunStateControl(reengagementState, setReengagementState, {
                    off: '关闭',
                    shadow: 'Shadow 观测',
                    live: '真实发送',
                  })}
                </div>
              </div>
            </div>

            <div className={styles.subPanel}>
              <div className={styles.scenarioPanel}>
                <button
                  type="button"
                  className={styles.scenarioPanelToggle}
                  aria-expanded={scenariosExpanded}
                  onClick={() => setScenariosExpanded((v) => !v)}
                >
                  <span className={styles.settingLabel}>场景清单与场景级开关</span>
                  {reengagementScenarios && reengagementScenarios.length > 0 ? (
                    <span className={styles.scenarioPanelHint}>
                      {reengagementScenarios.length} 个场景 · {scenarioOnCount} 个已放开 ·
                      报名后大开关
                      {reengagementPostBookingEnabled ? '已开' : '已关'}
                    </span>
                  ) : (
                    <span className={styles.scenarioPanelHint}>加载中...</span>
                  )}
                  <span className={styles.scenarioPanelChevron} aria-hidden>
                    ▾
                  </span>
                </button>
                {scenariosExpanded && reengagementScenarios && reengagementScenarios.length > 0 ? (
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
                      「真实发送」需同时满足：总开关开启 + Shadow 观测关闭 +
                      场景开关开启（报名后场景还需
                      报名后大开关开启）；其余组合到点只走判断与生成、记录「本应发什么」。
                      候选人已回话、会话已终态或场景条件不再成立时，到点任务会自动取消。
                    </p>
                  </>
                ) : scenariosExpanded ? (
                  <div className={styles.loadingText}>加载场景清单中...</div>
                ) : null}
              </div>
            </div>
          </section>

          <section id="config-grouptask" className={styles.moduleSection}>
            <div className={styles.moduleHeader}>
              <div>
                <h3 className={styles.moduleTitle}>
                  群任务通知
                  {renderSectionModeBadge('instant')}
                </h3>
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
            <span className={styles.saveDockTitle}>
              {pendingChangeCount || 1} 项配置待保存
            </span>
            <span className={styles.saveDockText}>
              保存后约 5 秒内全实例生效；运行开关类配置已经即时生效。
            </span>
          </div>
          <div className={styles.saveDockActions}>
            <button className={styles.btnGhost} onClick={handleCancelEdit}>
              放弃更改
            </button>
            <button
              className={styles.btnPrimary}
              onClick={handleSaveConfig}
              disabled={updateConfig.isPending}
            >
              {updateConfig.isPending ? (
                '保存中...'
              ) : (
                <>
                  保存并生效 <kbd className={styles.shortcut}>⌘S</kbd>
                </>
              )}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
