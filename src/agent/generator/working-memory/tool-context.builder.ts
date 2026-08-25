import { ModelMessage } from 'ai';
import { ToolBuildContext } from '@shared-types/tool.types';
import type { TurnLedger } from '@shared-types/turn.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import { type LaborFormIntentDecision } from '@resolution/labor-form';
import type { CandidatePrefillField, CandidatePrefillHints } from '@resolution/candidate/types';
import { projectTurnHints } from '@resolution/evidence/merge';
import type { TurnHints } from '@resolution/evidence/claim.types';
import { unwrapUserProfileFacts } from '@memory/long-term/long-term.types';
import {
  type EntityExtractionResult,
  type SessionFacts,
  isSessionFactValue,
  unwrapSessionFactValue,
  unwrapSessionFacts,
} from '@memory/short-term/short-term.types';
import { ContextService } from '../context/context.service';
import { type GeneratorInvokeParams } from '../generator.types';
import { resolveGeocodeLocationAnchor } from './geocode-location-anchor.util';
import { type TurnStartMemory } from './memory-block.formatter';
import type { CorpusBlock } from '@shared-types/corpus.types';

/**
 * ToolBuildContext 组装（PreparationService 的纯函数辅助层）：
 * 记忆事实合并、品牌池/jobId provenance 集汇总，无 IO。
 */

/**
 * 组装工具上下文。entryStage / availableStages 交给 advance_stage 使用；
 * 回合内产物统一写入 ledger，交给 onTurnEnd 落盘。
 */
export function buildToolContext(input: {
  params: GeneratorInvokeParams;
  memory: TurnStartMemory;
  normalizedMessages: ModelMessage[];
  /** 与 transport messages 同批的结构化语料域；内部教学指令不会冒充 user evidence。 */
  conversationCorpusBlocks: CorpusBlock[];
  entryStage: string | null;
  stageGoals: Awaited<ReturnType<ContextService['compose']>>['stageGoals'];
  thresholds: Awaited<ReturnType<ContextService['compose']>>['thresholds'];
  ledger: TurnLedger;
  contactBrandAliases: string[];
  /** 本轮生效的会话品牌状态（持久化状态或首轮 seed），透传给工具兜底。 */
  sessionBrandState: SessionBrandState | null;
  currentUserMessage?: string;
  currentLaborFormIntent: LaborFormIntentDecision;
  /** 当前进行中预约工单的 jobId（改约场景 system prompt 暴露给模型的「岗位ID」），并入 provenance 集。 */
  bookingWorkOrderJobIds: number[];
}): ToolBuildContext {
  const {
    params,
    memory,
    normalizedMessages,
    conversationCorpusBlocks,
    entryStage,
    stageGoals,
    thresholds,
    ledger,
    contactBrandAliases,
    sessionBrandState,
    currentUserMessage,
    currentLaborFormIntent,
    bookingWorkOrderJobIds,
  } = input;
  const recentBrandPool = collectRecentBrandPool(memory.sessionMemory);
  // jobId provenance 闸门数据源：turn-start 已召回岗位集 + 进行中预约工单 jobId（改约路径）
  // + 本轮 job_list 抓取的候选池（由工具实时写入 ledger），
  // 供 precheck/booking 判定 jobId 是否有出处。
  const turnStartRecalledJobIds = collectRecentJobIds(memory.sessionMemory);
  for (const bookingWorkOrderJobId of bookingWorkOrderJobIds) {
    turnStartRecalledJobIds.add(bookingWorkOrderJobId);
  }
  const trustedSessionFacts = unwrapSessionFacts(memory.sessionMemory?.facts ?? null, {
    minConfidence: 'high',
  });
  const candidatePrefillHints = buildCandidatePrefillHints(memory.sessionMemory?.facts ?? null);
  const sessionFacts = mergeSessionFactsWithRuleClaims(
    trustedSessionFacts,
    memory.turnHints,
    currentLaborFormIntent,
  );
  const geocodeLocationAnchor = resolveGeocodeLocationAnchor({
    currentUserMessage,
    shortTermMessages: memory.shortTerm.messageWindow,
    currentFacts: memory.turnHints,
    sessionFacts: trustedSessionFacts,
  });
  return {
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
      lastJobListQuery: memory.sessionMemory?.lastJobListQuery ?? null,
      activeBookingJobIds: bookingWorkOrderJobIds,
      currentFocusJob: memory.sessionMemory?.currentFocusJob ?? null,
      recentBrandPool,
      bookingCandidateFacts: sessionFacts?.interview_info ?? null,
      invitedGroups: memory.sessionMemory?.invitedGroups ?? [],
      isRecalledJobId: (jobId: number) =>
        turnStartRecalledJobIds.has(jobId) ||
        ledger.jobs.fetchedJobs.some((job) => job.jobId === jobId),
      // 闸门拒绝时把合法 jobId 一并告知模型；本轮新召回的排在前面。
      get recalledJobIds() {
        return [
          ...ledger.jobs.fetchedJobs.map((job) => job.jobId),
          ...turnStartRecalledJobIds,
        ].filter((id, index, all) => all.indexOf(id) === index);
      },
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
    },
    ledger,
    runtime: {
      hasNewerUserInput: params.hasNewerUserInput,
      strategySource: params.strategySource,
      thresholds,
    },
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
 * D5 的信任门继续生效：medium/system 事实不进入 trustedSessionFacts，只投影为
 * 表单「带值求证」提示。工具能减少重复盘问，却不会把弱来源升级成报名事实。
 *
 * **2026-08-12 工序 A3**：覆盖面从性别一个字段推广到全部收资字段。三禁令
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

    // 性别另有 gender_source 旁路标记（系统标签回填），一并算 system 来源。
    const isSystemSourced =
      fact.source === 'system' ||
      (hintField === 'gender' && unwrapSessionFactValue(info.gender_source) === 'system');
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
function mergeSessionFactsWithRuleClaims(
  sessionFacts: EntityExtractionResult | null,
  turnHints: TurnHints | null,
  currentLaborFormIntent: LaborFormIntentDecision = { kind: 'ignore' },
): EntityExtractionResult | null {
  const currentRuleValues = projectTurnHints(turnHints, { minConfidence: 'high' });
  let merged: EntityExtractionResult | null;
  if (!currentRuleValues) {
    merged = sessionFacts;
  } else if (!sessionFacts) {
    merged = currentRuleValues;
  } else {
    merged = { ...sessionFacts };

    // interview_info: 非 null 的高置信值覆盖旧值
    const baseInfo = { ...sessionFacts.interview_info };
    const hcInfo = currentRuleValues.interview_info;
    for (const key of Object.keys(hcInfo) as Array<keyof typeof hcInfo>) {
      if (hcInfo[key] != null) {
        (baseInfo as Record<string, unknown>)[key] = hcInfo[key];
      }
    }
    merged.interview_info = baseInfo;

    // preferences: 非 null 的高置信值覆盖旧值
    const basePref = { ...sessionFacts.preferences };
    const hcPref = currentRuleValues.preferences;
    for (const key of Object.keys(hcPref) as Array<keyof typeof hcPref>) {
      if (hcPref[key] != null) {
        (basePref as Record<string, unknown>)[key] = hcPref[key];
      }
    }
    merged.preferences = basePref;
  }

  if (!merged || currentLaborFormIntent.kind === 'ignore') return merged;

  const previousLaborForm = merged.preferences.labor_form;
  const activeLaborForm =
    currentLaborFormIntent.kind === 'set'
      ? currentLaborFormIntent.value
      : previousLaborForm &&
          currentLaborFormIntent.clearedValues.some((value) => value === previousLaborForm)
        ? null
        : previousLaborForm;

  return {
    ...merged,
    preferences: { ...merged.preferences, labor_form: activeLaborForm },
  };
}

/**
 * 汇总本会话最近推荐过的品牌名（去重，按出现顺序保留）。
 *
 * 取 presentedJobs（真正发给候选人的岗位）+ lastCandidatePool（最近一次工具结果），
 * 并把 currentFocusJob 的品牌也带上。供 duliday_job_list 做品牌别名同音回指匹配。
 */
function collectRecentBrandPool(session: TurnStartMemory['sessionMemory']): string[] {
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
function collectRecentJobIds(session: TurnStartMemory['sessionMemory']): Set<number> {
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
