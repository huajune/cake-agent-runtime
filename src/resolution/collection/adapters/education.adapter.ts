/**
 * 学历槽位写入适配器。
 *
 * 链路：`parseEducation`（聊天轨学历词表 + 学校/学院语境守卫）→ 标准学历名 →
 * `normalizeEducationToId` 取海绵学历 id → 与契约 `acceptedOptions` 做**成员判定**。
 *
 * 为什么还要过契约成员判定：基线实测学历(labelId 2) 是 4 种按岗白名单——同一个「大专」
 * 在 A 岗是 accepted、在 B 岗根本不在选项集里。契约没列的学历不是"没匹配上"，是这个岗
 * 压根不收这一档，必须交由字段值提案写入口先筛后收，不能在这里悄悄塞个近似值。
 *
 * D4 纪律：optionCode 用契约回传的值，不写字面量；定位靠 optionLabel 语义比对
 * （海绵学历名与契约标签同源，基线实测「中专\技校\职高」只差分隔符）。
 */

import { normalizeEducationToId, parseEducation } from '@resolution/candidate/education';
import { SPONGE_EDUCATION_MAPPING } from '@sponge/sponge.enums';
import { findOptionBySemantics } from '../option-matching';
import type { AdapterInput, SlotProposal } from './adapter.types';

export function proposeEducation(input: AdapterInput): SlotProposal | null {
  const { field, candidateText } = input;
  const parsed = parseEducation(candidateText);
  if (!parsed) return null;

  const educationId = normalizeEducationToId(parsed.value);
  if (educationId === null) return null;

  // 海绵学历名 = 契约 optionLabel 的同源写法；折掉分隔符后全等即同一档。
  const canonical = normalizeLabel(SPONGE_EDUCATION_MAPPING[educationId] ?? parsed.value);
  const option = findOptionBySemantics(field, (label) => label === canonical);
  // 契约没有这一档 → 留空追问/交筛选判；不塞近似值（宁可多问一句，不可报错学历）。
  if (!option) return null;

  return {
    labelId: field.labelId,
    value: option.optionLabel,
    optionCodes: [option.optionCode],
    sourceText: parsed.excerpt,
    producer: 'candidate_quote',
  };
}

function normalizeLabel(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/[\\/、|]/gu, '');
}
