import { inferCitiesFromGeoSignals } from '@resolution/geo/city-adjudicator';
import { parseCandidateFieldsFromText } from '@resolution/candidate';
import { extractCandidateTextsFromCorpus } from '@resolution/signal/self-report';
import {
  isUserProfileFactValue,
  unwrapUserProfileFactValue,
  type UserProfileFacts,
} from '@memory/long-term/long-term.types';
import type {
  EntityExtractionResult,
  Preferences,
  SessionFacts,
  WeworkSessionState,
} from '@memory/short-term/short-term.types';
import { unwrapSessionFacts, unwrapSessionFactValue } from '@memory/short-term/short-term.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type {
  BrandResolutionSource,
  SessionBrandState,
} from '@resolution/brand/brand-resolution.types';
import { isValidLaborForm, type LaborFormIntentDecision } from '@resolution/labor-form';
import { projectTurnHints, resolveTurnHints } from '@resolution/turn-hints/reducer';
import type { TurnHintFieldPath, TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type { CorpusBlock } from '@shared-types/corpus.types';
import type { ModelMessage } from 'ai';
import type { AgentMemorySnapshot, GeneratorInvokeParams } from '../generator.types';
import type {
  HardConstraintsPromptView,
  PromptModel,
  PromptSecurityView,
  TurnHintsPromptView,
} from '../context/context.types';
import { FINAL_CHECK_RULES } from '../context/sections/procedural/final-check.section';
import { formatCurrentTime } from '@infra/utils/date.util';
import type { PromptInjectionAssessment } from '../../guardrail/input/prompt-injection-detector';
import { PromptInjectionDetector } from '../../guardrail/input/prompt-injection-detector';
import {
  visibleBookingJobIds,
  type MemoryPromptView,
} from '../context/sections/semantic/memory.section';
import type { CreateTurnLedgerInput } from './turn-ledger';
import type { NormalizedTurnInput } from './conversation-normalizer';
import type { TurnSourceSnapshot } from './turn-data-loader.service';
import { adjudicatePromptMemory, resolveActiveLaborForm } from './prompt-memory-adjudicator';
import { extractTextFromContent } from './conversation-normalizer';
import { resolveToolContextModel, type ToolContextModel } from './tool-context.builder';
import type { LoadedGeoAnchor } from './turn-data-loader.service';
import { resolveBrandMentionKeys } from '@resolution/brand/brand-matcher';
import { selectEvidenceDialogueMessages } from '@resolution/signal/corpus';

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
    brandCatalog: sources.brandCatalog,
    mentionedBrands: collectMentionedBrands({
      sources,
      conversationCorpusBlocks,
      contactName: params.contactName,
    }),
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
    // 群聊判据只认 imRoomId（与渠道层 isGroupChat 同源）。apiType 是托管平台的
    // 企业级/小组级 API 档位，小组级账号的 1:1 私聊同样带 apiType='group'——
    // 用它判通道会给私聊注入「被 @ 才回复、隐私信息引导私聊」的群聊规范。
    channelType: params.imRoomId ? 'group' : 'private',
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

/**
 * 只汇总本次业务上下文提及过的品牌，不裁定意向、不更新品牌状态。
 * 复用品牌域目录、词形归一与品类配置；负向/履历照收，教学与工具参数不入语料。
 */
function collectMentionedBrands(input: {
  sources: TurnSourceSnapshot;
  conversationCorpusBlocks: readonly CorpusBlock[];
  contactName?: string;
}): ReadonlySet<string> | null {
  const { sources } = input;
  const catalog = sources.brandCatalog;
  if (
    !catalog?.length ||
    sources.memory._warnings?.length ||
    sources.booking.state === 'hidden' ||
    sources.warnings.some((warning) =>
      ['brand', 'brand_catalog', 'visual_facts'].includes(warning.source),
    )
  ) {
    return null;
  }

  const mentioned = new Set<string>();
  const collect = (value: unknown, source: BrandResolutionSource = 'user_text') => {
    const texts = Array.isArray(value) ? value : [value];
    for (const text of texts) {
      if (typeof text !== 'string' || !text.trim()) continue;
      for (const key of resolveBrandMentionKeys(text, source, catalog)) mentioned.add(key);
    }
  };
  const collectIds = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const id of value) {
      const brand = catalog.find((item) => item.id === id);
      if (brand) collect(brand.name);
    }
  };

  // 不剥引用块、不只选候选人自陈：本集合只回答“是否提及”，不负责归属或极性。
  for (const message of selectEvidenceDialogueMessages(input.conversationCorpusBlocks)) {
    collect(extractTextFromContent(message.content));
  }
  collect(input.contactName, 'contact_name');
  collect(sources.turnBrandContext.nicknameBrands, 'contact_name');

  const session = sources.memory.shortTerm.sessionState;
  for (const state of [session?.facts?.brand, sources.turnBrandContext.state]) {
    collect(state?.currentBrand?.canonicalName);
    collect(state?.excludedBrands?.map((brand) => brand.canonicalName));
  }
  collectIds(unwrapSessionFactValue(session?.facts?.preferences?.brand_ids));
  collect(unwrapUserProfileFactValue(sources.memory.longTerm.semantic.jobIntent?.brands));

  // 与工具 archive.recentBrandPool 相同的三个历史岗位来源，额外承接岗位名中的品牌。
  const jobs = [
    ...(session?.presentedJobs ?? []),
    ...(session?.lastCandidatePool ?? []),
    ...(session?.currentFocusJob ? [session.currentFocusJob] : []),
  ];
  for (const job of jobs) {
    collect(job.brandName);
    collect(job.jobName);
  }
  if (sources.booking.state === 'active') {
    for (const { workOrder } of sources.booking.entries) {
      collect(workOrder.brandName);
      collect(workOrder.jobName);
      collectIds([workOrder.brandId]);
    }
  }
  for (const sheet of sources.visualSheetsByContent?.values() ?? []) {
    collect(sheet.rawDescription, 'image_description');
    collect(
      sheet.fields.map((field) => field.value),
      'image_description',
    );
  }
  return mentioned;
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

/** 把共享 TurnHints 裁决结果投影成 Section 可直接渲染的两档视图。 */
export function resolveTurnHintsPromptView(input: {
  displayTurnHints: TurnHints | null;
  pendingFields: readonly TurnHintFieldPath[];
  currentTurnTexts: readonly string[];
}): TurnHintsPromptView {
  const pending = new Set(input.pendingFields);
  const currentFields = new Set<TurnHintFieldPath>();
  for (const fact of resolveTurnHints(input.displayTurnHints)) {
    if (!pending.has(fact.field)) currentFields.add(fact.field);
  }
  return {
    current: selectClaims(input.displayTurnHints, currentFields),
    pendingConfirmation: selectClaims(input.displayTurnHints, pending),
    currentTurnTexts: input.currentTurnTexts,
  };
}

/** 合并会话事实与本轮高置信规则事实；同一份结果同时约束 Prompt 与工具模型。 */
export function resolveHardConstraintsPromptView(input: {
  sessionFacts: SessionFacts | null;
  turnHints: TurnHints | null;
  laborFormIntent: LaborFormIntentDecision;
  brandState: SessionBrandState | null;
}): HardConstraintsPromptView {
  const trusted = unwrapSessionFacts(input.sessionFacts, { minConfidence: 'high' });
  const current = projectTurnHints(input.turnHints, { minConfidence: 'high' });
  const hasFacts = Boolean(trusted || current || input.laborFormIntent.kind === 'set');
  if (!hasFacts) return { facts: null, brandState: input.brandState };

  const interview: EntityExtractionResult['interview_info'] = {
    ...emptyInterviewInfo(),
    ...dropNulls(trusted?.interview_info),
    ...dropNulls(current?.interview_info),
  };
  const previousLaborForm =
    current?.preferences.labor_form ?? trusted?.preferences.labor_form ?? null;
  const activeLaborForm =
    input.laborFormIntent.kind === 'set'
      ? input.laborFormIntent.value
      : input.laborFormIntent.kind === 'clear' &&
          isValidLaborForm(previousLaborForm) &&
          input.laborFormIntent.clearedValues.some((value) => value === previousLaborForm)
        ? null
        : previousLaborForm;

  const preferences: Preferences = {
    brand_ids: current?.preferences.brand_ids ?? trusted?.preferences.brand_ids ?? null,
    salary: current?.preferences.salary ?? trusted?.preferences.salary ?? null,
    position: current?.preferences.position ?? trusted?.preferences.position ?? null,
    schedule: current?.preferences.schedule ?? trusted?.preferences.schedule ?? null,
    city: current?.preferences.city ?? trusted?.preferences.city ?? null,
    district: current?.preferences.district ?? trusted?.preferences.district ?? null,
    location: current?.preferences.location ?? trusted?.preferences.location ?? null,
    labor_form: activeLaborForm,
    delayed_intent:
      current?.preferences.delayed_intent ?? trusted?.preferences.delayed_intent ?? null,
    short_term: current?.preferences.short_term ?? trusted?.preferences.short_term ?? null,
    open_position: current?.preferences.open_position ?? trusted?.preferences.open_position ?? null,
    time_windows: current?.preferences.time_windows ?? trusted?.preferences.time_windows ?? null,
    schedule_constraint:
      current?.preferences.schedule_constraint ?? trusted?.preferences.schedule_constraint ?? null,
    available_after:
      current?.preferences.available_after ?? trusted?.preferences.available_after ?? null,
  };

  return { facts: { interview, preferences }, brandState: input.brandState };
}

function selectClaims(
  hints: TurnHints | null,
  fields: ReadonlySet<TurnHintFieldPath>,
): TurnHints | null {
  if (!hints) return null;
  const claims = hints.claims.filter((claim) => fields.has(claim.field));
  return claims.length > 0 ? { claims, reasoning: hints.reasoning } : null;
}

function dropNulls(
  obj: EntityExtractionResult['interview_info'] | undefined,
): Partial<EntityExtractionResult['interview_info']> {
  if (!obj) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    result[key] = value;
  }
  return result as Partial<EntityExtractionResult['interview_info']>;
}

function emptyInterviewInfo(): EntityExtractionResult['interview_info'] {
  return {
    name: null,
    phone: null,
    gender: null,
    age: null,
    is_student: null,
    education: null,
    has_health_certificate: null,
    upload_resume: null,
  };
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
