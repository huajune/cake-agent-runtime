/**
 * precheck 各类字段（性别 / 健康证 / 学历 / 身份 / 文本 / 数字 / 数组）的归一化。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）。
 *
 * 设计原则：
 * - 容忍噪声输入（候选人原话），归一为内部 enum 字符串
 * - 显式不识别的输入返回原文本（不强行匹配），由上层决定是否进 missingFields
 * - 性别/健康证 等业务 enum 与 sponge 后端 mapping 保持一致
 */

import { getAvailableSpongeEducations } from '@sponge/sponge.enums';
import { normalizePolicyText } from '@tools/utils/job-policy-parser';

export function isUnrestrictedGenderRequirement(value: string | null | undefined): boolean {
  const normalized = normalizePolicyText(value).replace(/\s+/g, '');
  if (!normalized || normalized === '不限') return true;
  return /男.*女|女.*男/.test(normalized);
}

export function formatConstraintText(value: string | null | undefined): string | null {
  const normalized = normalizePolicyText(value);
  if (!normalized) return null;
  return normalized.replace(/[\\/｜|]+/g, '、');
}

export function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function normalizeGenderValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  const hasMale = /男/.test(text);
  const hasStandaloneMale = /(^|[^女])男/.test(text);
  const hasFemale = /女/.test(text);
  if (hasMale && hasFemale) return null;
  if (hasStandaloneMale) return '男';
  if (hasFemale) return '女';
  return text;
}

export function normalizeHealthCertificateValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  // LLM occasionally serializes the boolean field as a string. Leaving "False" untouched makes
  // the checklist look complete while the policy resolver still treats it as unknown.
  if (/^(?:false|否|no|0)$/i.test(text)) return '无但接受办理健康证';
  if (/^(?:true|是|yes|1)$/i.test(text)) return '有';
  if (/非本地|不是本地|外地|异地/.test(text)) return null;
  if (/^有$|有健康证|本地.{0,4}健康证|健康证.{0,4}本地/.test(text)) return '有';
  // 显式拒办优先识别，避免被下方"无但接受办理"模式误吞
  if (/无且不接受办理健康证|不办健康证|不接受办健康证|不接受办理/.test(text)) {
    return '无且不接受办理健康证';
  }
  if (/无但接受办理健康证|可以办健康证|可办健康证|接受办健康证|接受办理/.test(text)) {
    return '无但接受办理健康证';
  }
  // “在办/等出证”代表当前仍未持证，但已接受办理。不能保留成任意文本，否则 checklist
  // 会误以为字段已收齐，而 health policy 仍返回 unknown，导致面试前持证岗位穿透预检。
  if (
    /健康证.{0,6}(?:在办|办理中|正在办|等出证|待出证)|(?:在办|办理中|正在办).{0,6}健康证|预计.{0,8}出证/.test(
      text,
    )
  ) {
    return '无但接受办理健康证';
  }
  // 候选人直接答"无/没有"等，按两步问法默认视为"无但接受办理健康证"
  // （现实中拒办的候选人通常不会来报名，业务侧已达成共识；后续若追加拒办信号会覆盖）。
  if (/^无$|没健康证|没有健康证|无健康证/.test(text)) return '无但接受办理健康证';
  return text;
}

export function normalizeEducationValue(value: string | null | undefined): string | null {
  const text = normalizePolicyText(value);
  if (!text) return null;
  const supported = getAvailableSpongeEducations();
  if (supported.includes(text)) return text;
  return text;
}

export function normalizeIdentityText(value: boolean | null | undefined): string | null {
  if (value == null) return null;
  return value ? '学生' : '社会人士';
}

/**
 * 当已知年龄 ≥ 25 时，默认候选人为社会人士，不再询问"是否学生"。
 *
 * 业务背景：候选人 30 岁还被问"是不是学生"。25 岁是保守分界
 * （硕士毕业通常 24~25 岁），避免误判个别超龄学生。
 *
 * 返回 null 表示无法判定（候选人自报/档案里显式 is_student 仍以原始值为准）。
 */
export function inferIdentityFromAge(ageText: string | null | undefined): string | null {
  if (!ageText) return null;
  const match = ageText.match(/\d+/);
  if (!match) return null;
  const age = parseInt(match[0], 10);
  if (!Number.isFinite(age)) return null;
  if (age >= 25) return '社会人士';
  return null;
}

export function normalizeTextValue(value: unknown): string | null {
  return typeof value === 'string' ? normalizePolicyText(value) || null : null;
}

export function normalizeNumberText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return normalizePolicyText(value) || null;
  return null;
}

export function normalizeArrayText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => normalizeTextValue(item)).filter(Boolean);
  return items.length > 0 ? items.join('、') : null;
}
