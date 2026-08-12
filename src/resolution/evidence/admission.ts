import {
  hasHonorificSuffix,
  hasStructuredNameSubmission,
  isFromAutoGreeting,
  stripSelfIntroPrefix,
} from '@resolution/candidate/name';
import { isNameOnlyQuotedSpeaker } from './identity-gates';
import { isDigitsOnlyName } from '@resolution/candidate/name';
import { isPlausibleAgeValue } from '@resolution/candidate/age';
import { isRecognizedCityName } from '@resolution/geo';
import { hasSelfReportedPhoneProvenance } from '@resolution/signal/self-report';
import {
  hasFieldProvenanceInWindow,
  hasHealthCertificateTopicEvidence,
  hasIsStudentTopicEvidence,
  isStorableCandidatePhone,
} from './admission-gates';
import { detectScalarFanoutValues, SCALAR_FANOUT_FIELD_THRESHOLD } from './admission-gates';
import { isVisualDescriptionText } from '@resolution/signal/markers';
import {
  isSelfReportedVisualMessage,
  type FinalizedVisualFactSheet,
  type VisualFactFieldKey,
  type VisualFactKind,
} from '@resolution/signal/visual';

export type DroppedNameReason = 'auto_greeting_nickname' | 'honorific_suffix';

type NameBearingFacts = {
  interview_info?: ({ name?: string | null } & Record<string, unknown>) | null;
} & Record<string, unknown>;

export interface SanitizeNameResult<T extends NameBearingFacts> {
  sanitized: T;
  droppedName: string | null;
  droppedReason: DroppedNameReason | null;
}

/** 候选人姓名入档前的统一准入门；不拥有事实，仅返回纯函数裁决。 */
export function sanitizeInterviewName<T extends NameBearingFacts>(
  facts: T,
  userMessages: readonly string[],
): SanitizeNameResult<T> {
  const name = facts.interview_info?.name?.trim();
  if (!name) return { sanitized: facts, droppedName: null, droppedReason: null };

  if (hasHonorificSuffix(name)) {
    return {
      sanitized: {
        ...facts,
        interview_info: { ...facts.interview_info, name: null },
      } as T,
      droppedName: name,
      droppedReason: 'honorific_suffix',
    };
  }

  const stripped = stripSelfIntroPrefix(name);
  const fromGreeting = stripped !== name || isFromAutoGreeting(name, userMessages);
  if (!fromGreeting || hasStructuredNameSubmission(name, userMessages)) {
    return { sanitized: facts, droppedName: null, droppedReason: null };
  }

  return {
    sanitized: {
      ...facts,
      interview_info: { ...facts.interview_info, name: null },
    } as T,
    droppedName: name,
    droppedReason: 'auto_greeting_nickname',
  };
}

type FactGroup = Record<string, unknown>;
type AdmissionFacts = {
  interview_info: object;
  preferences: object;
};

export interface EvidenceAdmissionDrop {
  group: 'interview_info' | 'preferences';
  field: string;
  droppedValue: unknown;
  reason: string;
  message: string;
}

export interface EvidenceAdmissionFlags {
  droppedQuotedSpeakerName: boolean;
  droppedDigitsName: boolean;
  droppedPhone: boolean;
  droppedCity: boolean;
}

export interface ApplyEvidenceAdmissionInput<T extends AdmissionFacts> {
  facts: T;
  previousFacts?: AdmissionFacts | null;
  messages: readonly unknown[];
  userMessages: readonly string[];
  selfReportedUserTexts: readonly string[];
  assistantTexts: readonly string[];
}

function unwrapFactValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value?: unknown }).value;
  }
  return value;
}

function replaceFactValue(group: FactGroup, field: string, value: unknown): void {
  const current = group[field];
  group[field] =
    current && typeof current === 'object' && 'value' in current
      ? { ...(current as Record<string, unknown>), value }
      : value;
}

function normalizeArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      )
    : [];
}

function isPlausibleLocationValue(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= 60 &&
    !/[？?]/u.test(value) &&
    !/(?:工资|薪资|时薪|月薪|上班|下班|早班|晚班|年龄|学历|健康证)/u.test(value) &&
    !/^\d+(?:\.\d+)?$/u.test(value)
  );
}

/**
 * 候选人档案统一准入链。每一步只做字段级裁决，返回结构化 dropped 记录；
 * memory 负责持久化和观测，不再拥有字段语义。
 */
export function applyEvidenceAdmission<T extends AdmissionFacts>(
  input: ApplyEvidenceAdmissionInput<T>,
): { facts: T; dropped: EvidenceAdmissionDrop[]; flags: EvidenceAdmissionFlags } {
  const facts = {
    ...input.facts,
    interview_info: { ...input.facts.interview_info },
    preferences: { ...input.facts.preferences },
  } as T;
  const interviewInfo = facts.interview_info as FactGroup;
  const preferences = facts.preferences as FactGroup;
  const previousInterviewInfo = input.previousFacts?.interview_info as FactGroup | undefined;
  const dropped: EvidenceAdmissionDrop[] = [];
  const drop = (
    group: EvidenceAdmissionDrop['group'],
    field: string,
    droppedValue: unknown,
    reason: string,
    message: string,
  ): void => {
    (facts[group] as FactGroup)[field] = null;
    dropped.push({ group, field, droppedValue, reason, message });
  };
  const infoValue = (field: string): unknown => unwrapFactValue(interviewInfo[field]);
  const previousInfoValue = (field: string): unknown =>
    unwrapFactValue(previousInterviewInfo?.[field]);

  const extractedStudent = infoValue('is_student');
  if (
    typeof previousInfoValue('is_student') !== 'boolean' &&
    typeof extractedStudent === 'boolean' &&
    !hasIsStudentTopicEvidence(input.selfReportedUserTexts, input.assistantTexts)
  ) {
    drop(
      'interview_info',
      'is_student',
      extractedStudent,
      'first_write_no_identity_context',
      `is_student 首写无会话身份语境，丢弃臆造值 ${String(extractedStudent)}`,
    );
  }

  const extractedName = infoValue('name');
  const droppedQuotedSpeakerName =
    typeof extractedName === 'string' && isNameOnlyQuotedSpeaker(extractedName, input.messages);
  if (droppedQuotedSpeakerName) {
    drop(
      'interview_info',
      'name',
      extractedName,
      'quoted_speaker_name',
      `name 只以引用前缀发言人身份出现（极可能是经理名），丢弃「${extractedName}」`,
    );
  }
  const droppedDigitsName =
    !droppedQuotedSpeakerName &&
    typeof extractedName === 'string' &&
    isDigitsOnlyName(extractedName);
  if (droppedDigitsName) {
    drop(
      'interview_info',
      'name',
      extractedName,
      'digits_only_name',
      `name 为纯数字形态（疑似手机号错填姓名），丢弃「${extractedName}」`,
    );
  }

  const extractedPhone = infoValue('phone');
  const invalidPhoneShape =
    typeof extractedPhone === 'string' && !isStorableCandidatePhone(extractedPhone);
  if (invalidPhoneShape) {
    drop(
      'interview_info',
      'phone',
      extractedPhone,
      'invalid_phone_shape',
      `phone 非 11 位手机号形态，丢弃臆造值「${extractedPhone}」`,
    );
  }
  const foreignPhone =
    !invalidPhoneShape &&
    typeof extractedPhone === 'string' &&
    extractedPhone !== previousInfoValue('phone') &&
    !hasSelfReportedPhoneProvenance(extractedPhone, input.selfReportedUserTexts, {
      prefiltered: true,
    });
  if (foreignPhone) {
    drop(
      'interview_info',
      'phone',
      extractedPhone,
      'phone_not_self_reported',
      `phone 只出现在图片描述等第三方内容中，丢弃非自陈号码「${extractedPhone}」`,
    );
  }

  const provenanceContext = [...input.userMessages, ...input.assistantTexts];
  for (const field of ['applied_store', 'household_register_province'] as const) {
    const extracted = infoValue(field);
    if (
      typeof extracted === 'string' &&
      extracted !== previousInfoValue(field) &&
      !hasFieldProvenanceInWindow(extracted, provenanceContext)
    ) {
      drop(
        'interview_info',
        field,
        extracted,
        'no_provenance_in_window',
        `${field} 在会话窗口无出处，丢弃臆造值「${extracted}」`,
      );
    }
  }

  const extractedHealthCert = infoValue('has_health_certificate');
  if (
    previousInfoValue('has_health_certificate') == null &&
    extractedHealthCert != null &&
    !hasHealthCertificateTopicEvidence(input.selfReportedUserTexts, input.assistantTexts)
  ) {
    drop(
      'interview_info',
      'has_health_certificate',
      extractedHealthCert,
      'first_write_no_health_cert_context',
      `has_health_certificate 首写无健康证语境，丢弃臆造值「${String(extractedHealthCert)}」`,
    );
  }

  const fanoutScan: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(interviewInfo)) {
    fanoutScan[`interview_info.${field}`] = unwrapFactValue(value);
  }
  for (const [field, value] of Object.entries(preferences)) {
    fanoutScan[`preferences.${field}`] = unwrapFactValue(value);
  }
  const fanoutValues = detectScalarFanoutValues(fanoutScan);
  for (const [fieldPath, value] of Object.entries(fanoutScan)) {
    if (typeof value !== 'string' || !fanoutValues.has(value.trim())) continue;
    const [group, field] = fieldPath.split('.') as [EvidenceAdmissionDrop['group'], string];
    drop(
      group,
      field,
      value,
      'scalar_fanout',
      `标量扇出熔断：${fieldPath} 与 ≥${SCALAR_FANOUT_FIELD_THRESHOLD - 1} 个其他字段同值，丢弃「${value}」`,
    );
  }

  const city = unwrapFactValue(preferences.city);
  const droppedCity = typeof city === 'string' && !isRecognizedCityName(city);
  if (droppedCity) {
    drop(
      'preferences',
      'city',
      city,
      'invalid_city_shape',
      `pref.city 形状非法，丢弃臆造值「${city}」`,
    );
  }
  const age = infoValue('age');
  if (age != null && !isPlausibleAgeValue(age)) {
    drop(
      'interview_info',
      'age',
      age,
      'invalid_age_shape',
      `age 形状非法（须为 14-70 单一数字），丢弃臆造值「${String(age)}」`,
    );
  }

  // 区县准入只做形状合法性，不做白名单裁决（PR #1000 评审 P2-3）：
  // UNIQUE_SUBDIVISION_TO_CITY 是「区名→唯一城市」派生用的刻意窄表，规则轨故意把
  // 白名单外的歧义区名（鼓楼类）保留给 LLM 处理——按白名单 drop-on-null 会把这些
  // 合法偏好一并丢掉。白名单外的区名保留原值、不派生 city。
  const district = normalizeArrayValue(unwrapFactValue(preferences.district));
  if (unwrapFactValue(preferences.district) != null) {
    const acceptedDistricts = district.filter(isPlausibleLocationValue);
    const invalidDistricts = district.filter((value) => !acceptedDistricts.includes(value));
    if (invalidDistricts.length > 0) {
      replaceFactValue(
        preferences,
        'district',
        acceptedDistricts.length > 0 ? acceptedDistricts : null,
      );
      dropped.push({
        group: 'preferences',
        field: 'district',
        droppedValue: invalidDistricts,
        reason: 'invalid_district_value',
        message: `district 含非法形状值，丢弃「${invalidDistricts.join('、')}」`,
      });
    }
  }
  const location = normalizeArrayValue(unwrapFactValue(preferences.location));
  if (unwrapFactValue(preferences.location) != null) {
    const acceptedLocations = location.filter(isPlausibleLocationValue);
    const invalidLocations = location.filter((value) => !acceptedLocations.includes(value));
    if (invalidLocations.length > 0) {
      replaceFactValue(
        preferences,
        'location',
        acceptedLocations.length > 0 ? acceptedLocations : null,
      );
      dropped.push({
        group: 'preferences',
        field: 'location',
        droppedValue: invalidLocations,
        reason: 'invalid_location_value',
        message: `location 含非法地点值，丢弃「${invalidLocations.join('、')}」`,
      });
    }
  }

  return {
    facts,
    dropped,
    flags: {
      droppedQuotedSpeakerName,
      droppedDigitsName,
      droppedPhone: invalidPhoneShape || foreignPhone,
      droppedCity,
    },
  };
}

interface MessageExtractionScope {
  readonly identity: boolean;
  readonly phone: boolean;
  readonly preferences: boolean;
  readonly geo: boolean;
}

const SCOPE_ALL: MessageExtractionScope = {
  identity: true,
  phone: true,
  preferences: true,
  geo: true,
};
const SCOPE_NONE: MessageExtractionScope = {
  identity: false,
  phone: false,
  preferences: false,
  geo: false,
};
const SCOPE_SELF_REPORTED: MessageExtractionScope = {
  identity: true,
  phone: false,
  preferences: true,
  geo: true,
};

const KIND_EXTRACTION_SCOPE: Record<VisualFactKind, MessageExtractionScope> = {
  resume: SCOPE_SELF_REPORTED,
  certificate: SCOPE_SELF_REPORTED,
  map_location: { ...SCOPE_NONE, geo: true },
  job_posting: SCOPE_NONE,
  chat_screenshot: SCOPE_NONE,
  other: SCOPE_NONE,
};

/** visual kind 是候选人档案的准入条件，因此与其它字段门共居 admission。 */
export function resolveExtractionScope(
  message: string,
  sheet: FinalizedVisualFactSheet | null | undefined,
): MessageExtractionScope {
  if (!isVisualDescriptionText(message)) return SCOPE_ALL;
  if (sheet && !sheet.degraded) return KIND_EXTRACTION_SCOPE[sheet.kind];
  if (isSelfReportedVisualMessage(message)) return SCOPE_SELF_REPORTED;
  return { ...SCOPE_NONE, preferences: true, geo: true };
}

const MAP_LOCATION_CITY_KEYS: readonly VisualFactFieldKey[] = [
  'city',
  'address',
  'candidate_address',
];

export function mapLocationCityCandidates(sheet: FinalizedVisualFactSheet): string[] {
  if (sheet.kind !== 'map_location') return [];
  return sheet.fields
    .filter((field) => MAP_LOCATION_CITY_KEYS.includes(field.key))
    .sort((a, b) => MAP_LOCATION_CITY_KEYS.indexOf(a.key) - MAP_LOCATION_CITY_KEYS.indexOf(b.key))
    .map((field) => field.value);
}
