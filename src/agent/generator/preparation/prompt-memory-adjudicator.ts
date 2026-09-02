import { MemoryService } from '@memory/memory.service';
import { factConfidenceRank } from '@memory/confidence-rank';
import {
  isUserProfileFactValue,
  type JobIntentFacts,
  type UserProfileFacts,
} from '@memory/long-term/long-term.types';
import {
  isSessionFactValue,
  type SessionFacts,
  type WeworkSessionState,
  unwrapSessionFacts,
} from '@memory/short-term/short-term.types';
import type { TurnHintFieldPath, TurnHints } from '@resolution/turn-hints/turn-hint.types';
import {
  hasMeaningfulValue,
  isSameFactValue,
  projectTurnHints,
  resolveTurnHints,
} from '@resolution/turn-hints/reducer';
import { isValidLaborForm, type LaborFormIntentDecision } from '@resolution/labor-form';

/** 本轮 turn-start 记忆召回结果（preparation 与 prompt 渲染函数的公共输入形状）。 */
export type TurnStartMemory = Awaited<ReturnType<MemoryService['onTurnStart']>>;

export interface PromptMemoryConflict {
  label: string;
  archivedValue: unknown;
  sessionValue: unknown;
  /** 档案域宪法：只要当前会话有值，跨层胜者恒为 session。 */
  winner: 'session';
}

/**
 * preparation 阶段一次算出的共享裁决视图。
 *
 * 这是 prompt-only 副本：memory-block 与 turn-hints 共同消费，绝不写回存储或工具上下文。
 */
export interface PromptMemoryAdjudication {
  profile: UserProfileFacts | null;
  jobIntent: JobIntentFacts | null;
  sessionState: WeworkSessionState | null;
  conflicts: readonly PromptMemoryConflict[];
  displayTurnHints: TurnHints | null;
  pendingTurnHintFields: readonly TurnHintFieldPath[];
}

export interface PromptFactEnvelope {
  value: unknown;
  confidence: string;
  updatedAt?: string;
  extractedAt?: string;
}

export type PromptFactScope = 'profile' | 'session';

export interface PromptFactCandidate {
  scope: PromptFactScope;
  envelope: PromptFactEnvelope;
}

/** 当前轮明确用工形式覆盖旧会话事实；无当前值时沿用高置信会话事实。 */
export function resolveActiveLaborForm(
  memory: TurnStartMemory,
  currentIntent: LaborFormIntentDecision,
): string | null {
  const current = projectTurnHints(memory.turnHints, { minConfidence: 'high' })?.preferences
    .labor_form;
  const persisted = unwrapSessionFacts(memory.shortTerm.sessionState?.facts ?? null, {
    minConfidence: 'high',
  })?.preferences.labor_form;
  const previous = current ?? persisted ?? null;
  const resolved =
    currentIntent.kind === 'set'
      ? currentIntent.value
      : currentIntent.kind === 'clear' &&
          previous &&
          currentIntent.clearedValues.some((value) => value === previous)
        ? null
        : previous;
  return isValidLaborForm(resolved) ? resolved : null;
}

interface CrossLayerField {
  label: string;
  path?: TurnHintFieldPath;
  longTermGroup: 'profile' | 'jobIntent';
  longTermKey: string;
  sessionGroup: 'interview_info' | 'preferences';
  sessionKey: string;
}

const CROSS_LAYER_FIELDS: readonly CrossLayerField[] = [
  field('姓名', 'interview_info.name', 'profile', 'name', 'interview_info', 'name'),
  field('联系方式', 'interview_info.phone', 'profile', 'phone', 'interview_info', 'phone'),
  field('性别', 'interview_info.gender', 'profile', 'gender', 'interview_info', 'gender'),
  field('年龄', 'interview_info.age', 'profile', 'age', 'interview_info', 'age'),
  field(
    '是否学生',
    'interview_info.is_student',
    'profile',
    'is_student',
    'interview_info',
    'is_student',
  ),
  field('学历', 'interview_info.education', 'profile', 'education', 'interview_info', 'education'),
  field(
    '健康证',
    'interview_info.has_health_certificate',
    'profile',
    'has_health_certificate',
    'interview_info',
    'has_health_certificate',
  ),
  field('身高', 'interview_info.height', 'profile', 'height', 'interview_info', 'height'),
  field('体重', 'interview_info.weight', 'profile', 'weight', 'interview_info', 'weight'),
  field('意向城市', 'preferences.city', 'jobIntent', 'city', 'preferences', 'city'),
  field('意向区域', 'preferences.district', 'jobIntent', 'district', 'preferences', 'district'),
  field('意向地点', 'preferences.location', 'jobIntent', 'location', 'preferences', 'location'),
  field('意向岗位', 'preferences.position', 'jobIntent', 'position', 'preferences', 'position'),
  field('意向班次', 'preferences.schedule', 'jobIntent', 'schedule', 'preferences', 'schedule'),
  field('意向薪资', 'preferences.salary', 'jobIntent', 'salary', 'preferences', 'salary'),
  field(
    '用工形式',
    'preferences.labor_form',
    'jobIntent',
    'labor_form',
    'preferences',
    'labor_form',
  ),
  field(
    '排班硬约束',
    'preferences.schedule_constraint',
    'jobIntent',
    'schedule_constraint',
    'preferences',
    'schedule_constraint',
  ),
  field('推迟意向', undefined, 'jobIntent', 'delayed_intent', 'preferences', 'delayed_intent'),
  field(
    '最早可面日期',
    'preferences.available_after',
    'jobIntent',
    'available_after',
    'preferences',
    'available_after',
  ),
];

const SCOPE_AUTHORITY: Readonly<Record<PromptFactScope, number>> = {
  profile: 1,
  session: 2,
};

/**
 * 把长期 updatedAt / 会话 extractedAt 统一为毫秒比较键。
 * 缺失或非法值返回 null；比较方不得把 null 擅自解释成更旧或更新。
 */
export function normalizeFactTimeKey(fact: PromptFactEnvelope): number | null {
  const value = fact.extractedAt ?? fact.updatedAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 同作用域才比较置信度与新鲜度；跨作用域先按档案域宪法的权威链裁决。
 * 同层时间任一缺失时保守视为无法比较，保持输入顺序。
 */
function compareScopedFacts(left: PromptFactCandidate, right: PromptFactCandidate): number {
  if (left.scope !== right.scope) return SCOPE_AUTHORITY[left.scope] - SCOPE_AUTHORITY[right.scope];

  const confidenceDelta =
    factConfidenceRank(left.envelope.confidence) - factConfidenceRank(right.envelope.confidence);
  if (confidenceDelta !== 0) return confidenceDelta;

  const leftTime = normalizeFactTimeKey(left.envelope);
  const rightTime = normalizeFactTimeKey(right.envelope);
  if (leftTime === null || rightTime === null) return 0;
  return leftTime - rightTime;
}

/**
 * 档案域候选值的确定性选择器。完全同权或时间缺失时保守保留第一个候选值。
 * 当前数据形状每层只有一个值；导出此原语是为了把同层置信度/时间规则锁进字节级单测。
 */
export function selectPromptFactWinner(
  left: PromptFactCandidate,
  right: PromptFactCandidate,
): PromptFactCandidate {
  return compareScopedFacts(left, right) >= 0 ? left : right;
}

/** preparation 装配阶段的唯一裁决入口。 */
export function adjudicatePromptMemory(memory: TurnStartMemory): PromptMemoryAdjudication {
  const profile = memory.longTerm.semantic.profile
    ? ({ ...memory.longTerm.semantic.profile } as UserProfileFacts)
    : null;
  const jobIntent = memory.longTerm.semantic.jobIntent
    ? ({ ...memory.longTerm.semantic.jobIntent } as JobIntentFacts)
    : null;
  const sourceState = memory.shortTerm.sessionState;
  const sessionFacts = sourceState?.facts
    ? ({
        ...sourceState.facts,
        interview_info: { ...sourceState.facts.interview_info },
        preferences: { ...sourceState.facts.preferences },
      } as SessionFacts)
    : null;
  const sessionState = sourceState
    ? ({ ...sourceState, facts: sessionFacts } as WeworkSessionState)
    : null;
  const conflicts: PromptMemoryConflict[] = [];
  const canonicalFacts = new Map<TurnHintFieldPath, unknown>();

  for (const field of CROSS_LAYER_FIELDS) {
    const longTermRecord = field.longTermGroup === 'profile' ? profile : jobIntent;
    const sessionRecord = sessionFacts?.[field.sessionGroup] as unknown as
      | Record<string, unknown>
      | undefined;
    const archived = (longTermRecord as Record<string, unknown> | null)?.[field.longTermKey];
    const current = sessionRecord?.[field.sessionKey];
    const hasArchived = isUserProfileFactValue(archived) && hasMeaningfulValue(archived.value);
    const hasSession = isSessionFactValue(current) && hasMeaningfulValue(current.value);

    if (hasArchived && hasSession) {
      const winner = selectPromptFactWinner(
        { scope: 'session', envelope: current },
        { scope: 'profile', envelope: archived },
      ).scope;
      // 宪法链保证跨层 current session 恒胜；分支保留为断言，防未来改排序时静默倒置。
      if (winner !== 'session') throw new Error(`跨层裁决违反档案域宪法: ${field.label}`);

      (longTermRecord as Record<string, unknown>)[field.longTermKey] = null;
      if (!isSameFactValue(archived.value, current.value)) {
        conflicts.push({
          label: field.label,
          archivedValue: archived.value,
          sessionValue: current.value,
          winner: 'session',
        });
      }
      if (field.path) canonicalFacts.set(field.path, current.value);
      continue;
    }

    const single = hasSession ? current.value : hasArchived ? archived.value : undefined;
    if (field.path && hasMeaningfulValue(single)) canonicalFacts.set(field.path, single);
  }

  // 品牌轨的跨层去重单独处理：brands 不在 CROSS_LAYER_FIELDS——session 侧的品牌
  // 权威是 facts.brand 状态机（SessionBrandRef），不存在同名同形字段。会话当前品牌
  // 已覆盖长期意向品牌时，长期侧不再注入，避免同一会话自己的 consolidation 沉淀
  // 以「上一段求职会话」的名义回流（蒋强 case：[历史求职意向] 只剩一行本会话品牌）。
  const currentBrandName = sessionFacts?.brand?.currentBrand?.canonicalName;
  const archivedBrands = (jobIntent as Record<string, unknown> | null)?.brands;
  if (
    currentBrandName &&
    isUserProfileFactValue(archivedBrands) &&
    Array.isArray(archivedBrands.value) &&
    archivedBrands.value.length > 0 &&
    archivedBrands.value.every((brand) => brand === currentBrandName)
  ) {
    (jobIntent as Record<string, unknown>).brands = null;
  }

  // session 独有字段也属于 facts；供 turnHints 做同值去重/异值待确认。
  if (sessionFacts) {
    for (const hint of resolveTurnHints(memory.turnHints)) {
      if (canonicalFacts.has(hint.field)) continue;
      const fact = readSessionFactByPath(sessionFacts, hint.field);
      if (isSessionFactValue(fact) && hasMeaningfulValue(fact.value)) {
        canonicalFacts.set(hint.field, fact.value);
      }
    }
  }

  const hintView = adjudicateTurnHints(memory.turnHints, canonicalFacts);
  return {
    profile,
    jobIntent,
    sessionState,
    conflicts,
    displayTurnHints: hintView.displayTurnHints,
    pendingTurnHintFields: hintView.pendingTurnHintFields,
  };
}

function adjudicateTurnHints(
  turnHints: TurnHints | null,
  canonicalFacts: ReadonlyMap<TurnHintFieldPath, unknown>,
): { displayTurnHints: TurnHints | null; pendingTurnHintFields: TurnHintFieldPath[] } {
  if (!turnHints) return { displayTurnHints: null, pendingTurnHintFields: [] };

  const duplicateFields = new Set<TurnHintFieldPath>();
  const pendingFields = new Set<TurnHintFieldPath>();
  for (const hint of resolveTurnHints(turnHints)) {
    const factValue = canonicalFacts.get(hint.field);
    if (!hasMeaningfulValue(factValue) || !hasMeaningfulValue(hint.value)) continue;
    const target = isSameFactValue(factValue, hint.value) ? duplicateFields : pendingFields;
    target.add(hint.field);
  }

  const claims = turnHints.claims.filter((claim) => !duplicateFields.has(claim.field));
  return {
    displayTurnHints: claims.length > 0 ? { claims, reasoning: turnHints.reasoning } : null,
    pendingTurnHintFields: [...pendingFields],
  };
}

function readSessionFactByPath(facts: SessionFacts, path: TurnHintFieldPath): unknown {
  const [group, key] = path.split('.') as ['interview_info' | 'preferences', string];
  return (facts[group] as unknown as Record<string, unknown>)[key];
}

function field(
  label: string,
  path: TurnHintFieldPath | undefined,
  longTermGroup: CrossLayerField['longTermGroup'],
  longTermKey: string,
  sessionGroup: CrossLayerField['sessionGroup'],
  sessionKey: string,
): CrossLayerField {
  return { label, path, longTermGroup, longTermKey, sessionGroup, sessionKey };
}
