import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

const FABRICATION_ADMISSION_PATTERN =
  /(?:经历|经验|公司|报名表)[^。！？\n]{0,12}(?:假的|瞎填|乱填|编的|随便(?:写|填))|(?:瞎填|乱填|编的|随便(?:写|填))[^。！？\n]{0,12}(?:经历|经验|公司|报名表)|就是没有[^。！？\n]{0,8}随便写/u;
const COACHING_PATTERNS: readonly RegExp[] = [
  /(?:^|[，,；;。！？!?\n])(?:你)?(?:就|直接|得|应该|可以)?(?:说|回答|答|讲|告诉)[^，,；;。！？!?\n]{0,14}(?:做过|干过|有[^，,；;。！？!?\n]{0,6}经[验历])/u,
  /(?:面试官|店长)[^，,；;。！？!?\n]{0,12}(?:问|问起)[^，,；;。！？!?\n]{0,12}(?:经[验历])[^，,；;。！？!?\n]{0,8}(?:就说|回答|答)[：:]?[“"「『']?有/u,
  /(?:把|将)[^，,；;。！？!?\n]{0,16}(?:经历|经验|履历|报名信息)[^，,；;。！？!?\n]{0,8}(?:包装|美化)(?:成|为)?[^，,；;。！？!?\n]{0,12}(?:做过|有经验)?/u,
  /(?:门店|店里)[^，,；;。！？!?\n]{0,10}(?:不会|不)(?:查|核实)[^，,；;。！？!?\n]{0,8}(?:记录|经历|资料)/u,
];
const NEGATED_PREFIX_PATTERN =
  /(?:不要|别|不能|不得|不应|不该|禁止|避免|不建议)[^，,；;。！？!?\n]{0,8}$/u;

/** 候选人已自曝造假后，只拦封闭的继续造假指导句式。 */
export function detectExperienceFraudCoaching(
  text: string,
  userMessage?: string,
  recentUserTexts?: readonly string[],
): RuleContradiction | null {
  const userContext = [...(recentUserTexts ?? []), userMessage ?? ''].join('\n');
  if (!FABRICATION_ADMISSION_PATTERN.test(userContext)) return null;

  const coaching = COACHING_PATTERNS.some((pattern) => {
    const match = pattern.exec(text);
    if (!match) return false;
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 18), match.index ?? 0);
    return !NEGATED_PREFIX_PATTERN.test(prefix);
  });
  if (!coaching) return null;
  return {
    ruleId: 'experience_fraud_coaching',
    label: '候选人已自曝报名经历造假，回复仍教其在面试时声称做过/有经验或以不查记录背书',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
