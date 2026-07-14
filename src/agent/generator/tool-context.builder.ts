import { ModelMessage } from 'ai';
import { ToolBuildContext } from '@shared-types/tool.types';
import { type LaborFormIntentDecision } from '@memory/facts/labor-form';
import {
  filterHighConfidenceFacts,
  unwrapHighConfidenceFacts,
} from '@memory/facts/high-confidence-facts';
import { unwrapUserProfileFacts } from '@memory/types/long-term.types';
import {
  type EntityExtractionResult,
  type HighConfidenceFacts,
  type RecommendedJobSummary,
  unwrapSessionFacts,
} from '@memory/types/session-facts.types';
import { ContextService } from './context/context.service';
import { type GeneratorInvokeParams } from './generator.types';
import { resolveGeocodeLocationAnchor } from './geocode-location-anchor.util';
import { type TurnStartMemory } from './memory-block.formatter';

/**
 * ToolBuildContext 组装（PreparationService 的纯函数辅助层）：
 * 记忆事实合并、品牌池/jobId provenance 集汇总，无 IO。
 */

/**
 * 组装工具上下文。entryStage / availableStages 交给 advance_stage 使用；
 * onJobsFetched 回调把本轮候选池暂存到 turnState，交给 onTurnEnd 落盘。
 */
export function buildToolContext(input: {
  params: GeneratorInvokeParams;
  memory: TurnStartMemory;
  normalizedMessages: ModelMessage[];
  entryStage: string | null;
  stageGoals: Awaited<ReturnType<ContextService['compose']>>['stageGoals'];
  thresholds: Awaited<ReturnType<ContextService['compose']>>['thresholds'];
  turnState: { candidatePool: RecommendedJobSummary[] | null };
  contactBrandAliases: string[];
  currentUserMessage?: string;
  currentLaborFormIntent: LaborFormIntentDecision;
  /** 当前进行中预约工单的 jobId（改约场景 system prompt 暴露给模型的「岗位ID」），并入 provenance 集。 */
  bookingWorkOrderJobIds: number[];
}): ToolBuildContext {
  const {
    params,
    memory,
    normalizedMessages,
    entryStage,
    stageGoals,
    thresholds,
    turnState,
    contactBrandAliases,
    currentUserMessage,
    currentLaborFormIntent,
    bookingWorkOrderJobIds,
  } = input;
  const recentBrandPool = collectRecentBrandPool(memory.sessionMemory);
  // jobId provenance 闸门数据源：turn-start 已召回岗位集 + 进行中预约工单 jobId（改约路径）
  // + 本轮 job_list 抓取的候选池（turnState.candidatePool 由 onJobsFetched 实时写入），
  // 供 precheck/booking 判定 jobId 是否有出处。
  const turnStartRecalledJobIds = collectRecentJobIds(memory.sessionMemory);
  for (const bookingWorkOrderJobId of bookingWorkOrderJobIds) {
    turnStartRecalledJobIds.add(bookingWorkOrderJobId);
  }
  const highConfidenceSessionFacts = unwrapSessionFacts(memory.sessionMemory?.facts ?? null, {
    minConfidence: 'high',
  });
  const sessionFacts = mergeSessionFactsWithHighConfidence(
    highConfidenceSessionFacts,
    memory.highConfidenceFacts,
    currentLaborFormIntent,
  );
  const geocodeLocationAnchor = resolveGeocodeLocationAnchor({
    currentUserMessage,
    shortTermMessages: memory.shortTerm.messageWindow,
    currentFacts: memory.highConfidenceFacts,
    sessionFacts: highConfidenceSessionFacts,
  });
  return {
    userId: params.userId,
    corpId: params.corpId,
    sessionId: params.sessionId,
    messages: normalizedMessages,
    currentUserMessage,
    currentLaborFormIntent,
    thresholds,
    imageMessageIds: params.imageMessageIds,
    imageUrls: params.imageUrls,
    visualMessageTypes: params.visualMessageTypes,
    currentStage: entryStage,
    availableStages: Object.keys(stageGoals),
    stageGoals,
    onJobsFetched: async (jobs) => {
      turnState.candidatePool = jobs as RecommendedJobSummary[];
    },
    botUserId: params.botUserId,
    contactName: params.contactName,
    contactBrandAliases,
    botImId: params.botImId,
    groupId: params.groupId,
    strategySource: params.strategySource,
    profile: unwrapUserProfileFacts(memory.longTerm.profile, { minConfidence: 'high' }),
    sessionFacts,
    highConfidenceFacts: memory.highConfidenceFacts,
    geocodeLocationAnchor,
    currentFocusJob: memory.sessionMemory?.currentFocusJob ?? null,
    recentBrandPool,
    isRecalledJobId: (jobId: number) =>
      turnStartRecalledJobIds.has(jobId) ||
      (turnState.candidatePool?.some((j) => j.jobId === jobId) ?? false),
    token: params.token,
    imContactId: params.imContactId,
    imRoomId: params.imRoomId,
    chatId: params.sessionId,
    apiType: params.apiType,
    turnId: params.messageId,
  };
}

/**
 * 把本轮高置信识别结果（interview_info）叠加到上一轮 sessionFacts 上，
 * 让工具（如 precheck）能拿到当前消息里刚提供的候选人字段（年龄/姓名/电话等）。
 * 非 null 的高置信值覆盖旧值，null 不覆盖。
 */
function mergeSessionFactsWithHighConfidence(
  sessionFacts: EntityExtractionResult | null,
  highConfidence: HighConfidenceFacts | null,
  currentLaborFormIntent: LaborFormIntentDecision = { kind: 'ignore' },
): EntityExtractionResult | null {
  const highConfidenceValues = unwrapHighConfidenceFacts(filterHighConfidenceFacts(highConfidence));
  let merged: EntityExtractionResult | null;
  if (!highConfidenceValues) {
    merged = sessionFacts;
  } else if (!sessionFacts) {
    merged = highConfidenceValues;
  } else {
    merged = { ...sessionFacts };

    // interview_info: 非 null 的高置信值覆盖旧值
    const baseInfo = { ...sessionFacts.interview_info };
    const hcInfo = highConfidenceValues.interview_info;
    for (const key of Object.keys(hcInfo) as Array<keyof typeof hcInfo>) {
      if (hcInfo[key] != null) {
        (baseInfo as Record<string, unknown>)[key] = hcInfo[key];
      }
    }
    merged.interview_info = baseInfo;

    // preferences: 非 null 的高置信值覆盖旧值
    const basePref = { ...sessionFacts.preferences };
    const hcPref = highConfidenceValues.preferences;
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
