import type { ModelMessage, ToolSet } from 'ai';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { toErrorMessage } from '@infra/utils/error.util';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
import type {
  ToolArchiveContext,
  ToolBuildContext,
  ToolRuntimeContext,
  ToolSessionContext,
  ToolTurnInputContext,
} from '@shared-types/tool.types';
import type { GeocodeLocationAnchor, TurnLedger } from '@shared-types/turn.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import { type LaborFormIntentDecision } from '@resolution/labor-form';
import type { CandidatePrefillField, CandidatePrefillHints } from '@resolution/candidate/types';
import { unwrapUserProfileFacts } from '@memory/long-term/long-term.types';
import {
  type EntityExtractionResult,
  type SessionFacts,
  isSessionFactValue,
  unwrapSessionFacts,
} from '@memory/short-term/short-term.types';
import { type GeneratorInvokeParams, type GeneratorToolMode } from '../generator.types';
import { type TurnStartMemory } from './prompt-memory-adjudicator';
import { createTurnLedger } from './turn-ledger';
import type { CorpusBlock } from '@shared-types/corpus.types';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import type { StageGoalConfig, Threshold } from '@biz/strategy/types/strategy.types';
import { isHumanAgentTextMessage } from '@biz/message/utils/message-provenance.util';
import { produceTurnHints } from '@resolution/turn-hints/producers/rule-track';
import { projectTurnHints } from '@resolution/turn-hints/reducer';
import type { TurnHints } from '@resolution/turn-hints/turn-hint.types';
import { resolveCityFromDistrict } from '@resolution/geo';
import type {
  CityFact,
  EntityExtractionResult as GeocodeEntityExtractionResult,
  ShortTermMessage,
} from '@memory/short-term/short-term.types';
import { stripTimeContext } from '@resolution/signal/markers';
import {
  computeResultCount,
  computeToolCallStatus,
  extractToolApiCode,
  extractToolErrorType,
  SIDE_EFFECT_TOOLS,
} from '../tool-call-analysis';
import type { ResolvedTurnContext } from './turn-context-resolver';

/**
 * ToolBuildContext 组装（PreparationService 的纯函数辅助层）：
 * 记忆事实合并、品牌池/jobId provenance 集汇总，无 IO。
 */

export interface ToolContextModel {
  selection: {
    scenario: string;
    mode: GeneratorToolMode;
    allowedToolNames?: string[];
  };
  session: ToolSessionContext;
  archive: Omit<ToolArchiveContext, 'recalledJobIds' | 'isRecalledJobId'>;
  turnInput: ToolTurnInputContext;
  runtime: ToolRuntimeContext;
  turnStartRecalledJobIds: readonly number[];
}

const LOCATION_CONTINUATION_PATTERN =
  /(?:附近|周边|旁边|周围|这边|那边|这里|那里|近一点|近点|离这|离那)/;

interface ResolveGeocodeLocationAnchorInput {
  currentUserMessage?: string;
  shortTermMessages: ShortTermMessage[];
  currentFacts?: TurnHints | null;
  sessionFacts?: GeocodeEntityExtractionResult | null;
}

/** 解析本轮 geocode 的可信位置锚点。 */
export function resolveGeocodeLocationAnchor(
  input: ResolveGeocodeLocationAnchorInput,
): GeocodeLocationAnchor | undefined {
  const currentAnchor = anchorFromTurnHints(
    input.currentFacts,
    'current_user',
    `当前候选人消息：${input.currentUserMessage ?? ''}`,
    input.currentUserMessage,
  );
  if (currentAnchor) return currentAnchor;

  const current = input.currentUserMessage?.trim() ?? '';
  if (!LOCATION_CONTINUATION_PATTERN.test(current)) return undefined;

  let index = input.shortTermMessages.length - 1;
  while (index >= 0 && input.shortTermMessages[index].role === 'user') index -= 1;
  while (index >= 0 && input.shortTermMessages[index].role === 'assistant') {
    const message = input.shortTermMessages[index];
    if (!isHumanAgentTextMessage(message)) break;
    const text = stripTimeContext(message.content).trim();
    const manualAnchor = anchorFromTurnHints(
      produceTurnHints([text], []),
      'human_agent',
      `人工招募经理消息：${text}`,
      text,
    );
    if (manualAnchor) return manualAnchor;
    index -= 1;
  }

  const sessionReference = [
    cityValue(input.sessionFacts?.preferences.city),
    ...(input.sessionFacts?.preferences.district ?? []),
    ...(input.sessionFacts?.preferences.location ?? []),
  ]
    .filter(Boolean)
    .join('');
  return (
    toGeocodeAnchor(
      input.sessionFacts,
      'session_memory',
      '高置信会话位置事实',
      sessionReference || undefined,
    ) ?? undefined
  );
}

function cityValue(city: CityFact | string | null | undefined): string | undefined {
  if (!city) return undefined;
  return typeof city === 'string' ? city : city.value;
}

function toGeocodeAnchor(
  facts: GeocodeEntityExtractionResult | null | undefined,
  source: GeocodeLocationAnchor['source'],
  evidence: string,
  referenceText?: string,
): GeocodeLocationAnchor | null {
  if (!facts) return null;
  const rawDistricts = Array.from(
    new Set((facts.preferences.district ?? []).map((item) => item.trim()).filter(Boolean)),
  );
  const districts = rawDistricts.length === 1 ? rawDistricts : [];
  const city = cityValue(facts.preferences.city) ?? resolveCityFromDistrict(districts[0] ?? '');
  if (!city && districts.length === 0) return null;
  return { city, districts, source, referenceText, evidence: evidence.slice(0, 200) };
}

function anchorFromTurnHints(
  facts: TurnHints | null | undefined,
  source: GeocodeLocationAnchor['source'],
  evidence: string,
  referenceText?: string,
): GeocodeLocationAnchor | null {
  return toGeocodeAnchor(
    projectTurnHints(facts, { minConfidence: 'high' }),
    source,
    evidence,
    referenceText,
  );
}

/** Resolver 阶段完成工具上下文的事实投影；不创建可变 Ledger，不执行 IO。 */
export function resolveToolContextModel(input: {
  params: GeneratorInvokeParams;
  memory: TurnStartMemory;
  normalizedMessages: ModelMessage[];
  /** 与 transport messages 同批的结构化语料域；内部教学指令不会冒充 user evidence。 */
  conversationCorpusBlocks: CorpusBlock[];
  entryStage: string | null;
  stageGoals: Record<string, StageGoalConfig>;
  thresholds: Threshold[];
  resolvedSessionFacts: EntityExtractionResult | null;
  contactBrandAliases: string[];
  /** 本轮生效的会话品牌状态（持久化状态或首轮 seed），透传给工具兜底。 */
  sessionBrandState: SessionBrandState | null;
  currentUserMessage?: string;
  currentLaborFormIntent: LaborFormIntentDecision;
  /** 当前进行中预约工单的 jobId（改约场景 system prompt 暴露给模型的「岗位ID」），并入 provenance 集。 */
  bookingWorkOrderJobIds: number[];
  /** 剥时间后缀内容 → 视觉事实 sheet；出处公证据此认简历/证件类自陈材料。 */
  visualSheetsByContent?: ReadonlyMap<string, FinalizedVisualFactSheet>;
}): ToolContextModel {
  const {
    params,
    memory,
    normalizedMessages,
    conversationCorpusBlocks,
    entryStage,
    stageGoals,
    thresholds,
    contactBrandAliases,
    sessionBrandState,
    currentUserMessage,
    currentLaborFormIntent,
    bookingWorkOrderJobIds,
  } = input;
  const recentBrandPool = collectRecentBrandPool(memory.shortTerm.sessionState);
  // jobId provenance 闸门数据源：turn-start 已召回岗位集 + 进行中预约工单 jobId（改约路径）
  // + 本轮 job_list 抓取的候选池（由工具实时写入 ledger），
  // 供 precheck/booking 判定 jobId 是否有出处。
  const turnStartRecalledJobIds = collectRecentJobIds(memory.shortTerm.sessionState);
  for (const bookingWorkOrderJobId of bookingWorkOrderJobIds) {
    turnStartRecalledJobIds.add(bookingWorkOrderJobId);
  }
  const trustedSessionFacts = unwrapSessionFacts(memory.shortTerm.sessionState?.facts ?? null, {
    minConfidence: 'high',
  });
  const candidatePrefillHints = buildCandidatePrefillHints(
    memory.shortTerm.sessionState?.facts ?? null,
  );
  const sessionFacts = input.resolvedSessionFacts;
  const geocodeLocationAnchor = resolveGeocodeLocationAnchor({
    currentUserMessage,
    shortTermMessages: memory.shortTerm.messageWindow,
    currentFacts: memory.turnHints,
    sessionFacts: trustedSessionFacts,
  });
  return {
    selection: {
      scenario: params.scenario ?? 'candidate-consultation',
      mode: params.toolMode ?? 'scenario',
      allowedToolNames: params.allowedToolNames,
    },
    session: {
      userId: params.userId,
      corpId: params.corpId,
      sessionId: params.sessionId,
      chatId: params.sessionId,
      token: params.token,
      imContactId: params.imContactId,
      imRoomId: params.imRoomId,
      apiType: params.apiType,
      botUserId: params.botUserId,
      botImId: params.botImId,
      groupId: params.groupId,
      turnId: params.messageId,
      contactName: params.contactName,
    },
    archive: {
      profile: unwrapUserProfileFacts(memory.longTerm.semantic.profile, { minConfidence: 'high' }),
      sessionFacts,
      candidatePrefillHints,
      sessionBrandState,
      currentStage: entryStage,
      availableStages: Object.keys(stageGoals),
      stageGoals,
      lastJobListQuery: memory.shortTerm.sessionState?.lastJobListQuery ?? null,
      activeBookingJobIds: bookingWorkOrderJobIds,
      currentFocusJob: memory.shortTerm.sessionState?.currentFocusJob ?? null,
      recentBrandPool,
      bookingCandidateFacts: sessionFacts?.interview_info ?? null,
      invitedGroups: memory.shortTerm.sessionState?.invitedGroups ?? [],
    },
    turnInput: {
      messages: normalizedMessages,
      corpusBlocks: conversationCorpusBlocks,
      currentUserMessage,
      currentLaborFormIntent,
      imageMessageIds: params.imageMessageIds,
      imageUrls: params.imageUrls,
      visualMessageTypes: params.visualMessageTypes,
      contactBrandAliases,
      geocodeLocationAnchor,
      visualSheetsByContent: input.visualSheetsByContent,
    },
    runtime: {
      hasNewerUserInput: params.hasNewerUserInput,
      strategySource: params.strategySource,
      thresholds,
    },
    turnStartRecalledJobIds: [...turnStartRecalledJobIds],
  };
}

/** Tool Runtime 阶段只把可变 Ledger 绑定到已经裁决好的工具模型。 */
export function buildToolContext(model: ToolContextModel, ledger: TurnLedger): ToolBuildContext {
  const turnStartIds = new Set(model.turnStartRecalledJobIds);
  const archive: ToolArchiveContext = {
    ...model.archive,
    isRecalledJobId: (jobId: number) =>
      turnStartIds.has(jobId) || ledger.jobs.fetchedJobs.some((job) => job.jobId === jobId),
    get recalledJobIds() {
      return [...ledger.jobs.fetchedJobs.map((job) => job.jobId), ...turnStartIds].filter(
        (id, index, all) => all.indexOf(id) === index,
      );
    },
  };
  return {
    session: model.session,
    archive,
    turnInput: model.turnInput,
    runtime: model.runtime,
    ledger,
  };
}

/** 弱来源字段 → 收资表单字段键（工序 A3：从性别一个字段推广到全字段）。 */
const PREFILL_HINT_FIELDS: ReadonlyArray<[CandidatePrefillField, string]> = [
  ['name', 'name'],
  ['phone', 'phone'],
  ['gender', 'gender'],
  ['age', 'age'],
  ['education', 'education'],
  ['healthCert', 'has_health_certificate'],
  ['householdProvince', 'household_register_province'],
  ['height', 'height'],
  ['weight', 'weight'],
];

/**
 * D5 的信任门继续生效：medium 与 system+非 high 事实只投影为表单「带值求证」
 * 提示；system+high 是报名办结确权，可进入 trustedSessionFacts。工具能减少重复盘问，
 * 却不会把弱来源升级成报名事实。
 *
 * **工序 A3**：覆盖面从性别一个字段推广到全部收资字段。三禁令
 * （不得据此拒绝 / 提交 / 升级来源）由 CandidatePrefillHint 类型注释承载，
 * 消费端（precheck prefilledConfirmationFields）逐字继承。
 */
function buildCandidatePrefillHints(
  facts: SessionFacts | EntityExtractionResult | null,
): CandidatePrefillHints | undefined {
  const info = facts?.interview_info;
  if (!info) return undefined;

  const hints: CandidatePrefillHints = {};
  for (const [hintField, factKey] of PREFILL_HINT_FIELDS) {
    const fact = (info as Record<string, unknown>)[factKey];
    if (!isSessionFactValue<string | number>(fact)) continue;
    const value = String(fact.value ?? '').trim();
    if (!value) continue;

    // gender 的 source+confidence 是唯一来源语义：
    // booking 是 system+high，可程序化预填；企微标签是 system+非 high，仍被安全闸拦截。
    const isSystemSourced =
      hintField === 'gender'
        ? fact.source === 'system' && fact.confidence !== 'high'
        : fact.source === 'system';
    const reason = isSystemSourced
      ? 'system_source'
      : fact.confidence === 'medium'
        ? 'medium_confidence'
        : null;
    if (!reason) continue;
    hints[hintField] = { value, reason };
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
}

/**
 * 把本轮高置信识别结果（interview_info）叠加到上一轮 sessionFacts 上，
 * 让工具（如 precheck）能拿到当前消息里刚提供的候选人字段（年龄/姓名/电话等）。
 * 非 null 的高置信值覆盖旧值，null 不覆盖。
 */
/**
 * 汇总本会话最近推荐过的品牌名（去重，按出现顺序保留）。
 *
 * 取 presentedJobs（真正发给候选人的岗位）+ lastCandidatePool（最近一次工具结果），
 * 并把 currentFocusJob 的品牌也带上。供 duliday_job_list 做品牌别名同音回指匹配。
 */
function collectRecentBrandPool(session: TurnStartMemory['shortTerm']['sessionState']): string[] {
  if (!session) return [];
  const ordered = [
    ...(session.presentedJobs ?? []),
    ...(session.lastCandidatePool ?? []),
    ...(session.currentFocusJob ? [session.currentFocusJob] : []),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const job of ordered) {
    const brand = job?.brandName?.trim();
    if (!brand) continue;
    if (seen.has(brand)) continue;
    seen.add(brand);
    result.push(brand);
  }
  return result;
}

/**
 * 汇总本会话 turn-start 已召回/展示过的全部 jobId（presentedJobs ∪ lastCandidatePool ∪
 * currentFocusJob，去重）。供 precheck/booking 的 jobId provenance 闸门判定"模型传入的 jobId
 * 是否有合法来源"——集合为空即本会话从未召回任何岗位，此时任何 jobId 都属凭空生成。
 */
function collectRecentJobIds(session: TurnStartMemory['shortTerm']['sessionState']): Set<number> {
  const ids = new Set<number>();
  if (!session) return ids;
  const ordered = [
    ...(session.presentedJobs ?? []),
    ...(session.lastCandidatePool ?? []),
    ...(session.currentFocusJob ? [session.currentFocusJob] : []),
  ];
  for (const job of ordered) {
    if (typeof job?.jobId === 'number') ids.add(job.jobId);
  }
  return ids;
}

const toolRuntimeLogger = new Logger('ToolRuntime');

/** 给工具 execute 包装真实耗时与统一观测。 */
export function wrapToolsWithTiming(
  tools: ToolSet,
  timings: Map<string, number>,
  tracer?: AgentTracerService,
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    const execute = (toolDef as { execute?: unknown }).execute;
    if (typeof execute !== 'function') {
      wrapped[name] = toolDef;
      continue;
    }
    wrapped[name] = {
      ...toolDef,
      execute: async (...args: unknown[]) => {
        const startedAt = Date.now();
        const options = args[1] as { toolCallId?: string } | undefined;
        try {
          const result = await (execute as (...callArgs: unknown[]) => unknown).apply(
            toolDef,
            args,
          );
          const durationMs = Date.now() - startedAt;
          recordToolTiming(name, timings, options, durationMs);
          const resultCount = computeResultCount(result);
          tracer?.emit({
            type: 'tool_call',
            toolName: name,
            durationMs,
            resultCount,
            status: computeToolCallStatus(result, resultCount, undefined, undefined, name),
            sideEffect: SIDE_EFFECT_TOOLS.has(name),
            errorType: extractToolErrorType(result),
            apiCode: extractToolApiCode(result),
          });
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          recordToolTiming(name, timings, options, durationMs);
          tracer?.emit({
            type: 'tool_error',
            toolName: name,
            durationMs,
            error: toErrorMessage(error),
          });
          throw error;
        }
      },
    } as ToolSet[string];
  }
  return wrapped;
}

function recordToolTiming(
  name: string,
  timings: Map<string, number>,
  options: { toolCallId?: string } | undefined,
  durationMs: number,
): void {
  if (options?.toolCallId) {
    timings.set(options.toolCallId, durationMs);
    return;
  }
  toolRuntimeLogger.warn(`[tool-timing] 工具 ${name} 执行选项缺少 toolCallId，真实计时未记录`);
}

/** 按 toolMode 与显式白名单过滤工具。 */
export function resolveToolsForMode(
  tools: ToolSet,
  mode: GeneratorToolMode,
  allowedToolNames?: string[],
): ToolSet {
  if (mode === 'none') return {};
  const modeTools: ToolSet = {};
  for (const [name, toolDef] of Object.entries(tools)) {
    if (mode === 'scenario' || !SIDE_EFFECT_TOOLS.has(name)) modeTools[name] = toolDef;
  }
  if (allowedToolNames === undefined) return modeTools;
  const allowed = new Set(allowedToolNames);
  return Object.fromEntries(Object.entries(modeTools).filter(([name]) => allowed.has(name)));
}

export interface ToolRuntime {
  tools: ToolSet;
  ledger: TurnLedger;
  toolExecutionTimings: Map<string, number>;
  availableToolCount: number;
  activeToolCount: number;
}

/** 把已裁决的工具模型绑定到单轮账本与实际工具集。 */
@Injectable()
export class ToolRuntimeBuilderService {
  private readonly logger = new Logger(ToolRuntimeBuilderService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  build(input: { resolved: ResolvedTurnContext }): ToolRuntime {
    const { resolved } = input;
    const ledger = createTurnLedger(resolved.ledgerSeed);
    if (resolved.initialGeoResolution) {
      const anchor = resolved.initialGeoResolution;
      ledger.recordGeoResolution({
        longitude: anchor.longitude,
        latitude: anchor.latitude,
        areaLevelQuery: false,
        areaName: null,
        city: anchor.city,
        district: anchor.district,
        evidence: anchor.evidence,
        source: 'location_share',
      });
      this.logger.log(
        `[prepare] 定位分享轮内锚点: city=${anchor.city}（invite 城市门 turn_geocode 档可用）`,
      );
    }

    const toolContext = buildToolContext(resolved.toolModel, ledger);
    const toolExecutionTimings = new Map<string, number>();
    const { scenario, mode, allowedToolNames } = resolved.toolModel.selection;
    const scenarioTools = this.toolRegistry.buildForScenario(scenario, toolContext) as ToolSet;
    const selectedTools = resolveToolsForMode(scenarioTools, mode, allowedToolNames);
    const tools = wrapToolsWithTiming(selectedTools, toolExecutionTimings, this.tracer);
    return {
      tools,
      ledger,
      toolExecutionTimings,
      availableToolCount: Object.keys(scenarioTools).length,
      activeToolCount: Object.keys(selectedTools).length,
    };
  }
}
