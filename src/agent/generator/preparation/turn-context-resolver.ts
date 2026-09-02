import { inferCitiesFromGeoSignals } from '@resolution/geo/city-adjudicator';
import { parseCandidateFieldsFromText } from '@resolution/candidate';
import { extractCandidateTextsFromCorpus } from '@resolution/signal/self-report';
import { isUserProfileFactValue, type UserProfileFacts } from '@memory/long-term/long-term.types';
import type { WeworkSessionState } from '@memory/short-term/short-term.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type { CorpusBlock } from '@shared-types/corpus.types';
import type { ModelMessage } from 'ai';
import type { AgentMemorySnapshot, GeneratorInvokeParams } from '../generator.types';
import type { PromptModel, PromptSecurityView } from '../context/prompt-model.types';
import { FINAL_CHECK_RULES } from '../context/sections/procedural/final-check.section';
import { formatCurrentTime } from '@infra/utils/date.util';
import type { PromptInjectionAssessment } from '../../guardrail/input/prompt-injection-detector';
import { PromptInjectionDetector } from '../../guardrail/input/prompt-injection-detector';
import {
  visibleBookingJobIds,
  type MemoryPromptView,
} from '../context/sections/semantic/memory.section';
import type { CreateTurnLedgerInput } from './turn-ledger';
import type { NormalizedTurnInput } from './turn-input-normalizer';
import type { TurnSourceSnapshot } from './turn-data-loader.service';
import { adjudicatePromptMemory, resolveActiveLaborForm } from './prompt-memory-adjudicator';
import {
  resolveHardConstraintsPromptView,
  resolveTurnHintsPromptView,
} from './prompt-view-resolver';
import { extractTextFromContent } from './conversation-normalizer';
import { resolveToolContextModel, type ToolContextModel } from './tool-context.builder';
import type { LoadedGeoAnchor } from './turn-data-loader.service';

const RETURNING_USER_ENTRY_STAGE = 'job_consultation';

export interface ResolvedTurnContext {
  entryStage: string | null;
  promptModel: PromptModel;
  toolModel: ToolContextModel;
  ledgerSeed: CreateTurnLedgerInput;
  initialGeoResolution?: LoadedGeoAnchor;
  memorySnapshot: AgentMemorySnapshot;
}

/**
 * 把原始源快照裁决成 Prompt 与工具共同消费的唯一回合视图。
 *
 * 这里不做 IO、不拼最终 Prompt，也不创建可变 Ledger；相同输入必然得到相同输出。
 */
export function resolveTurnContext(input: {
  params: GeneratorInvokeParams;
  normalizedInput: NormalizedTurnInput;
  sources: TurnSourceSnapshot;
  normalizedMessages: ModelMessage[];
  conversationCorpusBlocks: CorpusBlock[];
  injectionAssessment: PromptInjectionAssessment;
  /** 本轮统一时间锚点，避免纯裁决函数内部读取系统时钟。 */
  nowMs: number;
}): ResolvedTurnContext {
  const {
    params,
    normalizedInput,
    sources,
    normalizedMessages,
    conversationCorpusBlocks,
    injectionAssessment,
    nowMs,
  } = input;
  const promptMemoryView = adjudicatePromptMemory(sources.memory);
  const activeLaborForm = resolveActiveLaborForm(sources.memory, normalizedInput.laborFormIntent);
  const memoryView: MemoryPromptView = {
    adjudication: promptMemoryView,
    booking: sources.booking,
    realtimeGroups: sources.realtimeGroups,
    contactName: params.contactName,
    contactBrandAliases: sources.turnBrandContext.nicknameBrands,
    currentLaborFormIntent: normalizedInput.laborFormIntent,
    activeLaborForm,
  };

  const stageGoals = Object.fromEntries(
    sources.strategyConfig.stage_goals.stages.map((stage) => [stage.stage, stage]),
  );
  const persistedStage = sources.memory.shortTerm.stage.currentStage ?? undefined;
  const returningUserStage = persistedStage
    ? undefined
    : resolveReturningUserStage(sources.memory.longTerm.semantic.profile);
  const entryStage =
    persistedStage ??
    (returningUserStage && stageGoals[returningUserStage] ? returningUserStage : undefined) ??
    Object.keys(stageGoals)[0] ??
    null;
  const hardConstraints = resolveHardConstraintsPromptView({
    sessionFacts: sources.memory.shortTerm.sessionState?.facts ?? null,
    turnHints: sources.memory.turnHints,
    laborFormIntent: normalizedInput.laborFormIntent,
    brandState: sources.turnBrandContext.state,
  });
  const turnHintsView = resolveTurnHintsPromptView({
    displayTurnHints: promptMemoryView.displayTurnHints,
    pendingFields: promptMemoryView.pendingTurnHintFields,
    currentTurnTexts: normalizedInput.currentTurnTexts,
  });
  const security: PromptSecurityView = injectionAssessment.detected
    ? {
        injectionWarning: {
          ruleId: injectionAssessment.ruleId ?? 'prompt_injection.unknown',
          category: injectionAssessment.category ?? 'system_marker',
          instruction: PromptInjectionDetector.GUARD_INSTRUCTION,
        },
      }
    : {};

  const candidateTexts = extractCandidateTextsFromCorpus(conversationCorpusBlocks, {
    visualSheetsByContent: sources.visualSheetsByContent,
  });
  const bookingWorkOrderJobIds = visibleBookingJobIds(sources.booking);
  const ledgerSeed: CreateTurnLedgerInput = {
    turnHints: sources.memory.turnHints,
    laborFormIntent: normalizedInput.laborFormIntent,
    collectedFields: parseCandidateFieldsFromText(
      normalizedInput.currentUserMessage ? [normalizedInput.currentUserMessage] : [],
      nowMs,
    ),
    geoSignalCities: inferCitiesFromGeoSignals(candidateTexts),
    currentFocusJob: sources.memory.shortTerm.sessionState?.currentFocusJob ?? null,
  };
  // 历史阶段可能已从当前策略删除；保持旧 Context 行为：入口阶段继续写入工具/账本，
  // Prompt 的阶段策略回落当前配置首阶段，避免整个策略块静默消失。
  const currentStageConfig =
    (entryStage ? (stageGoals[entryStage] ?? null) : null) ??
    sources.strategyConfig.stage_goals.stages[0] ??
    null;
  const promptModel: PromptModel = {
    scenario: params.scenario ?? 'candidate-consultation',
    channelType: params.apiType === 'group' ? 'group' : 'private',
    currentTimeText: formatCurrentTime(nowMs),
    identity: {
      botUserId: params.botUserId,
      nickname: sources.accountIdentity.nickname ?? undefined,
      gender: sources.accountIdentity.gender ?? undefined,
    },
    strategy: {
      roleSetting: sources.strategyConfig.role_setting,
      persona: sources.strategyConfig.persona,
      redLines: sources.strategyConfig.red_lines,
      thresholds: sources.strategyConfig.red_lines.thresholds ?? [],
      stages: sources.strategyConfig.stage_goals.stages,
      currentStage: currentStageConfig,
    },
    memory: memoryView,
    groupInventory: sources.groupInventory,
    turnHints: turnHintsView,
    hardConstraints,
    security,
    criticalTurnInstructions: resolveCriticalTurnInstructions({
      currentUserMessage: normalizedInput.currentUserMessage,
      normalizedMessages,
    }),
  };
  const resolvedSessionFacts = hardConstraints.facts
    ? {
        interview_info: hardConstraints.facts.interview,
        preferences: hardConstraints.facts.preferences,
        reasoning: 'resolved turn constraints',
      }
    : null;
  const toolModel = resolveToolContextModel({
    params,
    memory: sources.memory,
    normalizedMessages,
    conversationCorpusBlocks,
    entryStage,
    stageGoals,
    thresholds: sources.strategyConfig.red_lines.thresholds ?? [],
    resolvedSessionFacts,
    contactBrandAliases: sources.turnBrandContext.nicknameBrands,
    sessionBrandState: sources.turnBrandContext.state,
    currentUserMessage: normalizedInput.currentUserMessage,
    currentLaborFormIntent: normalizedInput.laborFormIntent,
    bookingWorkOrderJobIds,
    visualSheetsByContent: sources.visualSheetsByContent,
  });

  return {
    entryStage,
    promptModel,
    toolModel,
    ledgerSeed,
    initialGeoResolution: sources.geoAnchor,
    memorySnapshot: buildMemorySnapshot(sources.memory, entryStage),
  };
}

function resolveReturningUserStage(profile: UserProfileFacts | null): string | undefined {
  if (!profile) return undefined;
  return profile.name?.value || profile.phone?.value ? RETURNING_USER_ENTRY_STAGE : undefined;
}

/** 关键轮规则裁决；Section 不读取原始消息或执行正则，只渲染确定性命中结果。 */
export function resolveCriticalTurnInstructions(input: {
  currentUserMessage?: string;
  normalizedMessages: readonly ModelMessage[];
}): string[] {
  const current = input.currentUserMessage ?? '';
  const recent = input.normalizedMessages
    .slice(-12)
    .map((message) => `${message.role}: ${extractTextFromContent(message.content)}`)
    .join('\n');
  const combined = `${recent}\n${current}`;

  return FINAL_CHECK_RULES.filter((rule) => {
    if (rule.trigger !== 'turn') return false;
    const text = rule.target === 'current' ? current : combined;
    return rule.patterns.every((pattern) => pattern.test(text));
  }).map((rule) => rule.text);
}

function buildMemorySnapshot(
  memory: TurnSourceSnapshot['memory'],
  entryStage: string | null,
): AgentMemorySnapshot {
  const session = memory.shortTerm.sessionState;
  const presentedJobIds =
    session?.presentedJobs?.map((job) => job.jobId).filter((id): id is number => id != null) ??
    null;
  const recommendedJobIds =
    session?.lastCandidatePool?.map((job) => job.jobId).filter((id): id is number => id != null) ??
    null;
  const profile = memory.longTerm.semantic.profile;
  const profileKeys = profile
    ? Object.entries(profile)
        .filter(([, value]) => isUserProfileFactValue(value))
        .map(([key]) => key)
    : null;

  return {
    currentStage: entryStage,
    presentedJobIds: presentedJobIds?.length ? presentedJobIds : null,
    recommendedJobIds: recommendedJobIds?.length ? recommendedJobIds : null,
    sessionFacts: flattenSessionFacts(session?.facts ?? null),
    profileKeys: profileKeys?.length ? profileKeys : null,
    currentFocusJob: buildFocusJobSnapshot(session?.currentFocusJob ?? null),
  };
}

function buildFocusJobSnapshot(
  job: RecommendedJobSummary | null,
): AgentMemorySnapshot['currentFocusJob'] {
  if (!job) return null;
  const fields: NonNullable<AgentMemorySnapshot['currentFocusJob']>['availableDetailFields'] = [];
  if (job.salaryDesc) fields.push('salary');
  if (job.settlementSummary) fields.push('settlement');
  if (job.shiftSummary) fields.push('shift');
  if (job.welfareFacts) fields.push('welfare');
  if (job.ageRequirement) fields.push('age_requirement');
  if (job.educationRequirement) fields.push('education_requirement');
  if (job.healthCertificateRequirement) fields.push('health_certificate_requirement');
  if (job.studentRequirement) fields.push('student_requirement');
  if (job.storeAddress) fields.push('address');
  if (job.laborForm || job.partTimeJobType) fields.push('employment');
  return { jobId: job.jobId, availableDetailFields: fields };
}

function flattenSessionFacts(
  facts: WeworkSessionState['facts'] | null,
): Record<string, unknown> | null {
  if (!facts) return null;
  const flat: Record<string, unknown> = {};
  const collect = (group: Record<string, unknown> | null | undefined, prefix: string) => {
    if (!group) return;
    for (const [key, value] of Object.entries(group)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      flat[`${prefix}.${key}`] = value;
    }
  };
  collect(facts.interview_info as unknown as Record<string, unknown>, 'interview');
  collect(facts.preferences as unknown as Record<string, unknown>, 'pref');
  return Object.keys(flat).length > 0 ? flat : null;
}
