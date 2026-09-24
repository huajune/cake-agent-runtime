/**
 * 班次**排他性**约束的出处校验（形态对齐 `job_list_brand_provenance`）。
 *
 * onlyWeekends / onlyEvenings / onlyMornings 断言的是"候选人只能做这个时段"，
 * 是排他性硬约束：命中即把所有排班对不上的在招岗位整批剔除，剔空后工具会让 Agent
 * 照念"排班要求和你的时段对不上"。这句话一旦建立在模型的误读上，候选人会直接流失。
 *
 * 生产实证（运营 2026-09-24 重要 case 复核）：候选人在收资表单里回答
 * 「周末两天是否在岗：周末两天都在接受门店排班」——这是**可用性**（周末两天都能排），
 * 模型读成了**排他性** `onlyWeekends: true`（只能做周末），附近岗位被全数剔除，
 * 候选人听到"排班要求和你「只周末」的时段对不上"（chat 6ab26452ce406a6aeea65fce，
 * 2026-09-24 09:55 于 chat 6ab3a58fce406a6aeee5f0df 再次复现）。
 *
 * 判据直接复用规则轨 `extractScheduleConstraintStructured`（要求「只…周末/晚班/早班」
 * 或「找周末的兼职」这类求职表达），本文件不新增任何班次正则，也不触碰
 * `schedule-semantic.util.ts` 的早/中/晚班判定语义——运营「班次口径需重新裁定」的
 * 边界只允许做"没有原话依据就不许筛"这一层。
 *
 * 出处池只认候选人本人原话；Agent 自产回复、收资模板与工具回执都不是出处。
 * 出处池不可用（缺语料）时整体放行，与品牌出处闸同口径。
 */

import { extractScheduleConstraintStructured } from '@resolution/turn-hints/producers/rule-track-preferences';

/** 排他性班次字段：断言"只能做这个时段"，会触发整批剔除。 */
export const EXCLUSIVE_SHIFT_FIELDS = ['onlyWeekends', 'onlyEvenings', 'onlyMornings'] as const;
export type ExclusiveShiftField = (typeof EXCLUSIVE_SHIFT_FIELDS)[number];

export const EXCLUSIVE_SHIFT_FIELD_LABELS: Record<ExclusiveShiftField, string> = {
  onlyWeekends: '只能做周末',
  onlyEvenings: '只能做晚班',
  onlyMornings: '只能做早班',
};

/** 只读入参视图：本校验只关心排他性三字段，availableWindow/maxDaysPerWeek 不在范围内。 */
export interface ExclusiveShiftConstraintView {
  onlyWeekends?: boolean;
  onlyEvenings?: boolean;
  onlyMornings?: boolean;
}

/**
 * 找出「被断言为 true、但候选人原话里找不到依据」的排他性班次字段。
 *
 * @param candidateTexts 候选人本人原话（`extractCandidateTextsFromCorpus` 产出）；
 *                       `null`/`undefined` 表示出处池不可用，整体放行返回空数组。
 */
export function findUnsupportedExclusiveShiftFields(
  constraint: ExclusiveShiftConstraintView | null | undefined,
  candidateTexts: readonly string[] | null | undefined,
): ExclusiveShiftField[] {
  if (!constraint || candidateTexts == null) return [];

  const asserted = EXCLUSIVE_SHIFT_FIELDS.filter((field) => constraint[field] === true);
  if (asserted.length === 0) return [];

  const supported = new Set<ExclusiveShiftField>();
  for (const text of candidateTexts) {
    if (!text?.trim()) continue;
    const extracted = extractScheduleConstraintStructured(text);
    if (!extracted) continue;
    for (const field of asserted) {
      if (extracted[field] === true) supported.add(field);
    }
    if (supported.size === asserted.length) break;
  }

  return asserted.filter((field) => !supported.has(field));
}

/** 去掉缺出处的排他性字段；其余字段原样保留。入参不变更，返回新对象。 */
export function stripExclusiveShiftFields<T extends ExclusiveShiftConstraintView>(
  constraint: T,
  fields: readonly ExclusiveShiftField[],
): T {
  if (fields.length === 0) return constraint;
  const next = { ...constraint };
  for (const field of fields) delete next[field];
  return next;
}

/** 回执/日志用的人读标签，如「只能做周末（onlyWeekends）」。 */
export function formatExclusiveShiftFields(fields: readonly ExclusiveShiftField[]): string {
  return fields.map((field) => `${EXCLUSIVE_SHIFT_FIELD_LABELS[field]}（${field}）`).join('、');
}
