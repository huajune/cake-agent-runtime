import { SHIFT_TAGS, type ShiftTag } from './types';

/** 需求映射“早上/早晨/早班=早班+上午班”的原话词形；“开档”只对应早班，不在此列。 */
const EARLY_SHIFT_WORDS = /早班|早上|早晨/;

interface ShiftTagLists {
  includeAnyTags?: ShiftTag[];
  excludeTags?: ShiftTag[];
}

/**
 * 候选人原话说到早班/早上/早晨时，同一侧（想做或排除）已有早班标签却缺上午班的，补上上午班。
 * 只补齐需求里固定的映射，不新增方向；原话没有这些词（如只说“开档”）时原样返回。
 */
export function completeEarlyShiftMapping<T extends ShiftTagLists | null | undefined>(
  constraint: T,
  candidateText: string | null | undefined,
): T {
  if (!constraint || !candidateText || !EARLY_SHIFT_WORDS.test(candidateText)) return constraint;
  const complete = (tags: ShiftTag[] | undefined) =>
    tags?.includes('early') && !tags.includes('morning')
      ? SHIFT_TAGS.filter((tag) => tag === 'morning' || tags.includes(tag))
      : tags;
  const includeAnyTags = complete(constraint.includeAnyTags);
  const excludeTags = complete(constraint.excludeTags);
  if (includeAnyTags === constraint.includeAnyTags && excludeTags === constraint.excludeTags) {
    return constraint;
  }
  return {
    ...constraint,
    ...(includeAnyTags ? { includeAnyTags } : {}),
    ...(excludeTags ? { excludeTags } : {}),
  };
}
