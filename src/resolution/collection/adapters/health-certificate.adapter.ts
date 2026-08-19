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
  const { field, candidateText, historicalValues } = input;

  const eligibility = resolveLocalHealthCertificateEligibility({
    latestAnswer: candidateText,
    historicalValues: historicalValues ? [...historicalValues] : undefined,
  });
  const option = resolveOption(field, eligibility.status);
  if (!option) return null;

  // sourceText 取健康证识别器命中的原话片段；识别器认不出（值由历史二次确认推出）
  // 时不产提案——出处门无论如何都会拒收无出处的值，这里提前退出省一次审计噪音。
  const excerpt = parseHealthCertificateMatch(candidateText)?.excerpt;
  if (!excerpt) return null;

  return {
    labelId: field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    sourceText: excerpt,
    producer: 'candidate_quote',
  };
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
