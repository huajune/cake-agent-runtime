/**
 * 健康证槽位写入适配器（总纲「健康证状态机的去向」的落地面）。
 *
 * `resolveLocalHealthCertificateEligibility` 不删、逻辑不改，只**换输出端**：
 * 从改写 knownFieldMap['健康证情况'] 转岗为"把候选人自然语言裁决成健康证标签的
 * optionCode"。
 *
 * 五态分流（蓝图 §1）：
 * - 三确定态 → optionCode
 *   · `local_valid`            → 有本地有效健康证
 *   · `accepts_local_application` → 无本地有效健康证，接受办理
 *   · `rejects_local_application` → 无本地有效健康证，不接受办理
 * - 两不定态 → **留空追问**，不猜
 *   · `non_local_needs_confirmation`（持异地证，尚未表态是否重办——resolver 自带
 *      recommendedQuestion，调用方拿去问）
 *   · `unknown`（含 explicitNoCertificate：明确没证但没表态接不接受办理）
 *
 * D4：不写 optionCode 字面量（基线实测恰好是 1/2/3，但那是海绵主键不是语义）。
 * 定位靠 optionLabel 的语义判据；契约改了措辞就退化成留空追问，不按 ID 硬猜。
 */

import {
  resolveLocalHealthCertificateEligibility,
  type LocalHealthCertificateEligibilityStatus,
} from '@resolution/candidate/health-cert-eligibility';
import { parseHealthCertificateMatch } from '@resolution/candidate/health-cert';
import { findOptionBySemantics } from '../option-matching';
import type { ContractOption } from '../form.types';
import type { AdapterInput, SlotProposal } from './adapter.types';

/** 语义判据表：三确定态各自认哪种 optionLabel。判据写在标签词面，不写 ID。 */
const LABEL_MATCHERS: Record<
  'local_valid' | 'accepts_local_application' | 'rejects_local_application',
  (label: string) => boolean
> = {
  // 「有…健康证」且不以「无/没」开头。
  local_valid: (label) => /^有.*健康证$/u.test(label),
  // 「无…健康证，接受办理」——「不接受」由下一条认领，这里排除。
  accepts_local_application: (label) =>
    /^(?:无|没有).*健康证/u.test(label) && /(?<!不)接受办理/u.test(label),
  rejects_local_application: (label) =>
    /^(?:无|没有).*健康证/u.test(label) && /不接受办理/u.test(label),
};

export function proposeHealthCertificate(input: AdapterInput): SlotProposal | null {
  const { field, candidateText, historicalValues, answerBound } = input;

  const eligibility = resolveLocalHealthCertificateEligibility({
    latestAnswer: candidateText,
    historicalValues: historicalValues ? [...historicalValues] : undefined,
  });
  // sourceText 取健康证识别器命中的原话片段；识别器认不出（值由历史二次确认推出）
  // 时不产提案——出处门无论如何都会拒收无出处的值，这里提前退出省一次审计噪音。
  let status: LocalHealthCertificateEligibilityStatus = eligibility.status;
  let excerpt = parseHealthCertificateMatch(candidateText)?.excerpt ?? null;
  if (!excerpt && answerBound) {
    // 值已绑定到本槽位（表单行「有无本地健康证：有」拆行后、fieldValueProposals 定位后）：
    // 裸短答不带「健康证」三个字也能读——绑定关系就是语境。未绑定的自由语料不走这里，
    // 脱离语境的「有」能回答任何一问。「无」单独出现仍留空追问（未表态是否接受办理）。
    const bare = matchBareAnswer(candidateText);
    if (bare) {
      status = bare;
      excerpt = candidateText.trim();
    }
  }
  const option = resolveOption(field, status);
  if (!option || !excerpt) return null;

  return {
    labelId: field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    sourceText: excerpt,
    producer: 'candidate_quote',
  };
}

type DeterminateStatus = keyof typeof LABEL_MATCHERS;

/**
 * 绑定语境下的裸短答（0902 实测被值词表门拒收 8 条：「有」「有本地」「无,接受办理」）。
 * 只认封闭句形：肯定必须带「有」，表态必须带「办」或「接受/愿意」——裸「可以」「不」不收，
 * 那两个在健康证槽位上仍是歧义答（可以什么？不什么？）。先拒后收：「不接受办理」逐字含「接受办理」。
 */
const BARE_ANSWER_MATCHERS: ReadonlyArray<{ test: RegExp; status: DeterminateStatus }> = [
  {
    test: /^(?:无|没有?|没办过?|还没办?|没证|无证)?[，,、。\s]*(?:不接受(?:办理?)?|不愿意?办(?:理)?|不想办(?:理)?|不能办(?:理)?|不可以办(?:理)?|不去办(?:理)?|不办(?:理)?)$/u,
    status: 'rejects_local_application',
  },
  {
    test: /^(?:无|没有?|没办过?|还没办?|没证|无证)?[，,、。\s]*(?:接受(?:办理?)?|愿意(?:办理?)?|可以办(?:理)?|能办(?:理)?|可办(?:理)?)$/u,
    status: 'accepts_local_application',
  },
  { test: /^(?:有|有的|有证|有本地|本地有|🈶)$/u, status: 'local_valid' },
];

function matchBareAnswer(text: string): DeterminateStatus | null {
  const compact = text.normalize('NFKC').trim();
  if (!compact) return null;
  return BARE_ANSWER_MATCHERS.find(({ test }) => test.test(compact))?.status ?? null;
}

function resolveOption(
  field: AdapterInput['field'],
  status: LocalHealthCertificateEligibilityStatus,
): ContractOption | null {
  const matcher = LABEL_MATCHERS[status as keyof typeof LABEL_MATCHERS];
  // 两不定态（non_local_needs_confirmation / unknown）落不到表里 → 留空追问。
  if (!matcher) return null;
  return findOptionBySemantics(field, matcher);
}
