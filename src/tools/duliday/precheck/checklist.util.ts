/**
 * precheck 收资 checklist 构建：字段顺序、显示标签、模板渲染、已知字段映射。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）：
 * - FIELD_ORDER / FIELD_LABELS / TEMPLATE_CORE_FIELDS：业务侧定义的字段稳定顺序
 * - normalizeChecklistField / canonicalizeChecklistFields：字段名归一（联系电话 ≡ 联系方式）
 * - buildKnownFieldMap：把 contextProfile + sessionInterviewInfo 合并成 field→value map
 * - buildChecklistTemplate：渲染 "面试要求：..." 收资模板，自动按 FIELD_ORDER 排序
 * - buildEnumHintsForMissing：给 missingFields 返回 enum 候选值（性别/学历/省份等）
 */

import {
  getAvailableSpongeEducations,
  getAvailableSpongeProvinces,
  SPONGE_GENDER_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING,
} from '@sponge/sponge.enums';
import { normalizePolicyText } from '@tools/utils/job-policy-parser';
import { API_BOOKING_USER_OPTIONAL_FIELDS } from '@tools/duliday/booking/job-booking.contract';
import {
  dedupeStrings,
  inferIdentityFromAge,
  normalizeArrayText,
  normalizeEducationValue,
  normalizeGenderValue,
  normalizeHealthCertificateValue,
  normalizeIdentityText,
  normalizeNumberText,
  normalizeTextValue,
} from '@tools/duliday/precheck/field-normalize.util';

export const FIELD_ORDER = [
  '姓名',
  '联系电话',
  '性别',
  '年龄',
  '面试时间',
  '学历',
  '健康证情况',
  '健康证类型',
  '身份',
  '户籍省份',
  '身高',
  '体重',
  '简历附件',
  '过往公司+岗位+年限',
  '应聘门店',
  '应聘岗位',
];

export const TEMPLATE_CORE_FIELDS = ['姓名', '联系电话', '性别', '年龄', '面试时间', '应聘门店'];

export const FIELD_LABELS: Record<string, string> = {
  联系电话: '联系方式',
  健康证情况: '健康证',
  户籍省份: '籍贯/户籍',
  简历附件: '简历附件',
  // 历史 badcase：候选人看到"身份："以为是要身份证号。带括号说明枚举消歧。
  身份: '身份（学生/社会人士）',
};

const GENDER_ENUM_HINTS = Object.values(SPONGE_GENDER_MAPPING);

/**
 * 健康证首次询问时只暴露"有 / 无"两个选项给模型，让模型以最自然的方式问候选人。
 *
 * 业务背景：badcase ub4vrq3v —— "无但接受办理健康证" 等中间态选项会让候选人困惑，
 * 且现实中拒办的候选人通常不会来报名，默认按"无但接受办理健康证"收敛即可；只有候选人
 * 主动说"不接受办理"时才标记为"无且不接受办理健康证"。
 *
 * 完整三值（有 / 无但接受办理 / 无且不接受办理）仍保留在 SPONGE_HEALTH_CERTIFICATE_MAPPING
 * 用于 API 提交，不在此处展示。
 */
const HEALTH_CERT_ENUM_HINTS = ['有', '无'];

const HEALTH_CERT_TYPE_ENUM_HINTS = Object.values(SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING);

export function normalizeChecklistField(field: string | null | undefined): string {
  const normalized = normalizePolicyText(field);
  if (!normalized) return '';

  if (['联系电话', '联系方式', '电话'].includes(normalized)) return '联系电话';
  if (normalized === '健康证' || normalized === '健康证情况' || normalized === '有无健康证') {
    return '健康证情况';
  }
  if (normalized === '籍贯' || normalized === '户籍' || normalized === '户籍省份') {
    return '户籍省份';
  }
  if (normalized === '身份' || normalized === '是否学生') return '身份';
  if (/简历/.test(normalized)) return '简历附件';
  if (normalized === '过往公司+岗位+年限' || /工作经历|工作经验|过往公司/.test(normalized)) {
    return '过往公司+岗位+年限';
  }
  if (normalized === '面试日期') return '面试时间';

  return normalized;
}

export function canonicalizeChecklistFields(fields: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const field of fields) {
    const canonical = normalizeChecklistField(field);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }

  return result;
}

export function buildKnownFieldMap(params: {
  contextProfile?: {
    name?: string | null;
    phone?: string | null;
    gender?: string | null;
    age?: string | null;
    is_student?: boolean | null;
    education?: string | null;
    has_health_certificate?: string | null;
    household_register_province?: string | null;
    height?: string | number | null;
    weight?: string | number | null;
    upload_resume?: string | null;
    health_certificate_types?: string[] | null;
    experience?: string | null;
  } | null;
  sessionInterviewInfo?: {
    name?: string | null;
    phone?: string | null;
    gender?: string | null;
    age?: string | null;
    interview_time?: string | null;
    is_student?: boolean | null;
    education?: string | null;
    has_health_certificate?: string | null;
    applied_store?: string | null;
    applied_position?: string | null;
    household_register_province?: string | null;
    height?: string | number | null;
    weight?: string | number | null;
    upload_resume?: string | null;
    health_certificate_types?: string[] | null;
    experience?: string | null;
  } | null;
  storeName?: string | null;
  jobName?: string | null;
}): Record<string, string> {
  const info = params.sessionInterviewInfo;
  const profile = params.contextProfile;
  const householdRegisterProvince =
    normalizePolicyText(info?.household_register_province) ||
    normalizePolicyText(profile?.household_register_province) ||
    null;
  const ageText = normalizePolicyText(info?.age) || normalizePolicyText(profile?.age) || null;
  const identityLabel =
    normalizeIdentityText(info?.is_student) ||
    normalizeIdentityText(profile?.is_student) ||
    inferIdentityFromAge(ageText);

  const map: Record<string, string | null> = {
    姓名: normalizePolicyText(info?.name) || normalizePolicyText(profile?.name),
    联系电话: normalizePolicyText(info?.phone) || normalizePolicyText(profile?.phone),
    性别: normalizeGenderValue(info?.gender) || normalizeGenderValue(profile?.gender),
    年龄: ageText,
    面试时间: normalizePolicyText(info?.interview_time),
    学历: normalizeEducationValue(info?.education) || normalizeEducationValue(profile?.education),
    健康证情况:
      normalizeHealthCertificateValue(info?.has_health_certificate) ||
      normalizeHealthCertificateValue(profile?.has_health_certificate),
    健康证类型:
      normalizeArrayText(info?.health_certificate_types) ||
      normalizeArrayText(profile?.health_certificate_types),
    身份: identityLabel,
    户籍省份: householdRegisterProvince,
    身高: normalizeNumberText(info?.height) || normalizeNumberText(profile?.height),
    体重: normalizeNumberText(info?.weight) || normalizeNumberText(profile?.weight),
    简历附件: normalizeTextValue(info?.upload_resume) || normalizeTextValue(profile?.upload_resume),
    '过往公司+岗位+年限':
      normalizeTextValue(info?.experience) || normalizeTextValue(profile?.experience),
    应聘门店:
      normalizePolicyText(params.storeName) || normalizePolicyText(info?.applied_store) || null,
    应聘岗位:
      normalizePolicyText(params.jobName) || normalizePolicyText(info?.applied_position) || null,
  };

  const result: Record<string, string> = {};
  for (const [field, value] of Object.entries(map)) {
    if (value) result[field] = value;
  }
  return result;
}

export function orderFields(fields: string[]): string[] {
  const uniqueFields = dedupeStrings(fields);
  const ordered = FIELD_ORDER.filter((field) => uniqueFields.includes(field));
  const rest = uniqueFields.filter((field) => !FIELD_ORDER.includes(field)).sort();
  return [...ordered, ...rest];
}

export function formatTemplateFieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function buildChecklistTemplate(params: {
  requiredFields: string[];
  knownFieldMap: Record<string, string>;
}): {
  requiredFields: string[];
  displayOrder: string[];
  missingFields: string[];
  templateText: string;
} {
  const requiredFields = canonicalizeChecklistFields(params.requiredFields);
  const knownOptionalFields = Object.keys(params.knownFieldMap).filter(
    (field) =>
      !requiredFields.includes(field) &&
      (API_BOOKING_USER_OPTIONAL_FIELDS as readonly string[]).includes(field),
  );
  // TEMPLATE_CORE_FIELDS 是收资模板必要骨架（姓名/电话/性别/年龄/面试时间/应聘门店）。
  // 即使岗位 API 没把这些字段写进 requiredFields，也必须强制纳入展示——
  // badcase #2：API 漏了"姓名"，模板就把姓名整行删掉了，候选人按模板填一堆资料没填名字。
  const orderedFields = orderFields([
    ...TEMPLATE_CORE_FIELDS,
    ...requiredFields,
    ...knownOptionalFields,
  ]);
  const coreFields = TEMPLATE_CORE_FIELDS.filter((field) => orderedFields.includes(field));
  const dynamicFields = orderedFields.filter((field) => !TEMPLATE_CORE_FIELDS.includes(field));
  const displayOrder = [...coreFields, ...dynamicFields];

  const missingFields = displayOrder.filter((field) => !params.knownFieldMap[field]);

  const lines = [
    '面试要求：先将以下资料补充下发给我，我来帮你约面试',
    ...displayOrder.map((field) => {
      const value = params.knownFieldMap[field] ?? '';
      return `${formatTemplateFieldLabel(field)}：${value}`;
    }),
  ];

  return {
    requiredFields,
    displayOrder,
    missingFields,
    templateText: lines.join('\n'),
  };
}

export function buildEnumHintsForMissing(missingFields: string[]): Record<string, string[]> {
  const hints: Record<string, string[]> = {};
  if (missingFields.includes('性别')) hints.gender = [...GENDER_ENUM_HINTS];
  if (missingFields.includes('健康证情况')) hints.healthCertificate = [...HEALTH_CERT_ENUM_HINTS];
  if (missingFields.includes('健康证类型')) {
    hints.healthCertificateTypes = [...HEALTH_CERT_TYPE_ENUM_HINTS];
  }
  if (missingFields.includes('学历')) hints.education = getAvailableSpongeEducations();
  if (missingFields.some((field) => ['籍贯', '户籍', '户籍省份'].includes(field))) {
    hints.householdRegisterProvince = getAvailableSpongeProvinces();
  }
  if (missingFields.includes('身份')) {
    hints.identity = ['学生', '社会人士'];
  }
  return hints;
}
