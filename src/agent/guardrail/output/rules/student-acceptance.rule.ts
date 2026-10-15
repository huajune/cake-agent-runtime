import { createOutputRuleFinding } from '../output-rule-catalog';
import type { AgentToolCall } from '@agent/generator/generator.types';
import {
  unwrapSessionFactValue,
  type WeworkSessionState,
} from '@memory/short-term/short-term.types';
import { classifyStudentEligibility, type JobStudentTier } from '@resolution/job';
import { getTurnHintValue } from '@resolution/turn-hints/reducer';
import type { TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 学生身份 ↔ 已推荐岗位对账（observe 哨兵 `student_acceptance_contradiction`）。
 *
 * 背景（2026-10-09 batch_6ac85778ce406a6aeef8e575_1791515076511）：已展示的两家肯德基岗位
 * 社会身份档位都是「仅限社会人士」，候选人回「学生」，模型本轮零工具调用，直接答「这家接受学生」。
 * 查岗工具的学生硬过滤只在 duliday_job_list 内部运行，零工具轮没有任何结构化依据在场。
 *
 * 命中条件（全部满足）：
 * - 会话事实与本轮线索按高置信合并后，候选人已明确是学生；
 * - 本轮没有调用 duliday_job_list / duliday_interview_precheck（调过时本轮有新鲜岗位事实，交给工具口径）；
 * - 回复含「接受/收/招学生」「学生也可以」「不限身份」类肯定断言（否定、疑问、指向其他岗位的定语不算）；
 * - 会话已展示岗位与当前焦点岗位全部带结构化档位，且没有一家接受学生（均为不接受学生或字段为空）。
 *
 * 任一岗位缺档位（2026-10-14 前写入的历史记忆）或接受学生时无法公证回复指的是哪家，不判。
 */
export interface StudentAcceptanceEvidence {
  /** 会话事实与本轮规则线索按高置信合并后的学生身份；只有 true 才对账。 */
  candidateIsStudent: boolean | null;
  /** 已展示岗位与当前焦点岗位（按 jobId 去重）的结构化社会身份档位；null 表示历史记录未记录。 */
  jobs: ReadonlyArray<{ jobId: number; studentTier: JobStudentTier | null }>;
}

/** 本轮调过即视为有新鲜岗位要求事实（含学生筛选/社会身份栏），哨兵不再对账。 */
const FRESH_JOB_FACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'duliday_job_list',
  'duliday_interview_precheck',
]);

const STUDENT = '(?:学生|在校生)';
/** 分句结束或语气词：确保"学生也可以"是完整断言，而不是"学生可以看看别的岗位"。 */
const CLAUSE_TAIL = '(?=$|[，,。！!；;\\n、\\s~～哦哈呢啊呀噢喔滴])';

const STUDENT_ACCEPTANCE_PATTERNS: readonly RegExp[] = [
  // 接受学生 / 收学生 / 招学生；"学生证/学生卡"与"接受学生的岗位"（指其他岗位的定语）不算。
  new RegExp(
    `(?:接受|收|招|欢迎)(?:在校)?${STUDENT}(?![证卡])(?!的?(?:岗位|门店|工作|职位|店|家|品牌|地方))`,
    'u',
  ),
  new RegExp(
    `${STUDENT}(?:身份)?(?:的话)?(?:也|都)?(?:可以|能|行|没问题|OK|ok)(?:做|报名?|来|干|应聘|面试|上班|去|的)?${CLAUSE_TAIL}`,
    'u',
  ),
  new RegExp(`${STUDENT}(?:和|与|跟|或|、|/)社会人士(?:都|均)`, 'u'),
  new RegExp(`社会人士(?:和|与|跟|或|、|/)${STUDENT}(?:都|均)`, 'u'),
  /不限(?:学生|身份)|(?:学生|身份)不限|(?:没有|无|没)(?:学生|身份)(?:方面的)?(?:限制|要求)/u,
  /学生优先/u,
];

/** 断言前 3 个字内出现否定词即视为否定（不接受/没法收/并非不限）。 */
const NEGATION_PATTERN = /[不没无非别未禁]/u;
/** 同一分句里先提到其他岗位，说的是替代推荐，不是对已推荐岗位的断言。 */
const ALTERNATIVE_JOB_PATTERN = /其他|其它|别的|另外|换/u;
const CLAUSE_PATTERN = /[^，,。！!？?；;\n]+[，,。！!？?；;\n]?/gu;
const INTERROGATIVE_PATTERN = /(?:[？?]|[吗么嘛][~～]?[，,。！!；;\n]?)$/u;

/**
 * 从会话记忆与本轮线索组装哨兵证据。学生身份合并口径与提示词硬约束段一致：本轮高置信规则线索
 * 优先，其次会话高置信事实；岗位按 jobId 去重，重复时取已知档位。
 */
export function buildStudentAcceptanceEvidence(
  state: Pick<WeworkSessionState, 'facts' | 'presentedJobs' | 'currentFocusJob'> | null,
  turnHints: TurnHints | null | undefined,
): StudentAcceptanceEvidence {
  const fromTurn = getTurnHintValue<unknown>(turnHints, 'interview_info.is_student', {
    minConfidence: 'high',
  });
  const fromSession = unwrapSessionFactValue<boolean>(state?.facts?.interview_info?.is_student, {
    minConfidence: 'high',
  });
  const candidateIsStudent =
    typeof fromTurn === 'boolean'
      ? fromTurn
      : typeof fromSession === 'boolean'
        ? fromSession
        : null;

  const tiers = new Map<number, JobStudentTier | null>();
  for (const job of [
    ...(state?.currentFocusJob ? [state.currentFocusJob] : []),
    ...(state?.presentedJobs ?? []),
  ]) {
    const known = tiers.get(job.jobId);
    if (known === undefined || (known === null && job.studentTier)) {
      tiers.set(job.jobId, job.studentTier ?? null);
    }
  }
  return {
    candidateIsStudent,
    jobs: Array.from(tiers, ([jobId, studentTier]) => ({ jobId, studentTier })),
  };
}

/** 找出回复里第一处"该岗接受学生"的肯定断言原文；没有返回 null。 */
export function findStudentAcceptanceClaim(text: string): string | null {
  for (const clause of text.match(CLAUSE_PATTERN) ?? []) {
    if (INTERROGATIVE_PATTERN.test(clause.trim())) continue;
    for (const pattern of STUDENT_ACCEPTANCE_PATTERNS) {
      const match = pattern.exec(clause);
      if (!match) continue;
      const before = clause.slice(0, match.index);
      if (NEGATION_PATTERN.test(before.slice(-3))) continue;
      if (ALTERNATIVE_JOB_PATTERN.test(before)) continue;
      return match[0];
    }
  }
  return null;
}

export function detectStudentAcceptanceContradiction(
  text: string,
  toolCalls: AgentToolCall[] = [],
  evidence?: StudentAcceptanceEvidence,
): RuleContradiction | null {
  if (!text.trim() || evidence?.candidateIsStudent !== true) return null;
  if (toolCalls.some((call) => FRESH_JOB_FACT_TOOL_NAMES.has(call.toolName))) return null;
  if (evidence.jobs.length === 0) return null;
  const eligibilities = evidence.jobs.map((job) => classifyStudentEligibility(job.studentTier));
  if (eligibilities.some((value) => value === 'unrecorded' || value === 'accepts_student')) {
    return null;
  }

  const claim = findStudentAcceptanceClaim(text);
  if (!claim) return null;
  return createOutputRuleFinding(
    'student_acceptance_contradiction',
    `候选人已明确是学生，本轮未调用 duliday_job_list / duliday_interview_precheck，回复却断言「${claim}」；` +
      `会话已推荐岗位（jobId ${evidence.jobs.map((job) => job.jobId).join('、')}）的社会身份档位均为不接受学生或字段为空`,
  );
}
