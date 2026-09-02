import { inferCitiesFromGeoSignals } from '@resolution/geo/city-adjudicator';
import { parseCandidateFieldsFromText } from '@resolution/candidate';
import { extractCandidateTextsFromCorpus } from '@resolution/signal/self-report';
import { isUserProfileFactValue, type UserProfileFacts } from '@memory/long-term/long-term.types';
import type { WeworkSessionState } from '@memory/short-term/short-term.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type { CorpusBlock } from '@shared-types/corpus.types';
import type { ModelMessage } from 'ai';
import type { AgentMemorySnapshot, GeneratorInvokeParams } from '../generator.types';
import type { ComposeParams } from '../context/context.service';
import {
  visibleBookingJobIds,
  type MemoryPromptView,
} from '../context/sections/semantic/memory.section';
import type { CreateTurnLedgerInput } from './turn-ledger';
import type { NormalizedTurnInput } from './turn-input-normalizer';
import type { TurnSourceSnapshot } from './turn-data-loader.service';
import { adjudicatePromptMemory, resolveActiveLaborForm } from './prompt-memory-adjudicator';

const RETURNING_USER_ENTRY_STAGE = 'job_consultation';

export interface ResolvedTurnContext {
  entryStage: string | null;
  composeParams: ComposeParams;
  ledgerSeed: CreateTurnLedgerInput;
  bookingWorkOrderJobIds: number[];
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
  /** 本轮统一时间锚点，避免纯裁决函数内部读取系统时钟。 */
  nowMs: number;
}): ResolvedTurnContext {
  const { params, normalizedInput, sources, normalizedMessages, conversationCorpusBlocks, nowMs } =
    input;
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

  return {
    entryStage,
    composeParams: {
      strategyConfig: sources.strategyConfig,
      scenario: params.scenario ?? 'candidate-consultation',
      currentStage: persistedStage ?? returningUserStage,
      memory: memoryView,
      groupInventory: sources.groupInventory,
      sessionFacts: sources.memory.shortTerm.sessionState?.facts ?? null,
      turnHints: sources.memory.turnHints,
      displayTurnHints: promptMemoryView.displayTurnHints,
      pendingTurnHintFields: promptMemoryView.pendingTurnHintFields,
      currentTurnTexts: normalizedInput.currentTurnTexts,
      currentUserMessage: normalizedInput.currentUserMessage,
      normalizedMessages,
      currentLaborFormIntent: normalizedInput.laborFormIntent,
      sessionBrandState: sources.turnBrandContext.state,
      accountIdentity: {
        botUserId: params.botUserId,
        nickname: sources.accountIdentity.nickname ?? undefined,
        gender: sources.accountIdentity.gender ?? undefined,
      },
    },
    ledgerSeed,
    bookingWorkOrderJobIds,
    memorySnapshot: buildMemorySnapshot(sources.memory, entryStage),
  };
}

function resolveReturningUserStage(profile: UserProfileFacts | null): string | undefined {
  if (!profile) return undefined;
  return profile.name?.value || profile.phone?.value ? RETURNING_USER_ENTRY_STAGE : undefined;
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
