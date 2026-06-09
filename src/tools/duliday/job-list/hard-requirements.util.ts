/**
 * 从 raw job.hiringRequirement 派生候选人硬条件 enum（Phase 1.B 数据契约层）。
 *
 * 历史 badcase 簇：候选人意向某岗位 → 岗位有"不要 X 籍/限女性/必须有健康证/不接受学生"
 * 等硬条件，Agent 不主动核对就 booking → 候选人到店被刷或被店长拒。
 *
 * 当前 normalizedRequirements 是字符串字段（"18-40 岁" / "限本地" 等），Agent 解读时
 * 容易遗漏。这一层把硬条件结构化成显式 enum，便于：
 *  1. render 层用 markdown 高亮显示给 Agent
 *  2. booking-guards 层做 hard gate（候选人 facts 与硬约束冲突 → 拒 booking）
 *  3. precheck 层把 screeningChecks 与 hardRequirements 对账
 *
 * 设计原则：
 *  - 保守归类——只在 raw 数据明确表达"限/不要 X"时输出 include/exclude，
 *    其它情况一律 'unspecified'，避免误判
 *  - 输入是 raw job.hiringRequirement（任意 unknown 结构），输出是稳定 enum
 *  - 仅做派生不做校验——booking-guards 是另一层
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type GenderRequirement = 'male' | 'female' | 'any' | 'unspecified';

export type HouseholdRequirementMode = 'include' | 'exclude';

export interface HouseholdRequirement {
  /** include = 只接受这些户籍；exclude = 拒绝这些户籍 */
  mode: HouseholdRequirementMode;
  /** 户籍/省份/区域列表（原文，未做地理归一） */
  regions: string[];
}

export type HealthCertRequirement =
  | 'required_before_interview' // 面试前必须有
  | 'required_before_onboard' // 入职前必须有（可入职后办）
  | 'not_required' // 岗位明确不需要
  | 'unspecified'; // 数据未明确

export interface HardRequirements {
  gender: GenderRequirement;
  household: HouseholdRequirement | null;
  healthCert: HealthCertRequirement;
}

const FEMALE_TOKENS = new Set(['女', '女性', '仅女', '限女', '只要女', '只招女']);
const MALE_TOKENS = new Set(['男', '男性', '仅男', '限男', '只要男', '只招男']);
const ANY_TOKENS = new Set(['不限', '男女不限', '均可', '不限性别']);

function normalizeGender(raw: unknown): GenderRequirement {
  if (typeof raw !== 'string') return 'unspecified';
  const trimmed = raw.trim();
  if (!trimmed) return 'unspecified';
  // sponge 实际用逗号串表达多选，如 "男性,女性" / "女性,男性"（=不限）。
  // 先按分隔符拆分，命中男女两性即视为不限。
  const parts = trimmed
    .split(/[,，、/\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const hasMale = parts.some((p) => MALE_TOKENS.has(p) || /男/.test(p));
    const hasFemale = parts.some((p) => FEMALE_TOKENS.has(p) || /女/.test(p));
    if (hasMale && hasFemale) return 'any';
    if (hasFemale) return 'female';
    if (hasMale) return 'male';
  }
  if (FEMALE_TOKENS.has(trimmed)) return 'female';
  if (MALE_TOKENS.has(trimmed)) return 'male';
  if (ANY_TOKENS.has(trimmed)) return 'any';
  // 包含但不严格匹配（如"限女性 18-40"）
  if (/^限女|^只(要|招)女|仅女/.test(trimmed)) return 'female';
  if (/^限男|^只(要|招)男|仅男/.test(trimmed)) return 'male';
  if (/不限/.test(trimmed)) return 'any';
  return 'unspecified';
}

const HOUSEHOLD_EXCLUDE_TYPES = new Set(['不要', '不接受', '排除', '不限制（除）', '黑名单']);
const HOUSEHOLD_INCLUDE_TYPES = new Set(['限', '只要', '只接受', '白名单', '仅']);

/**
 * 从 hometown 块派生户籍约束 enum。
 *
 * sponge 字段：
 *  - nativePlaceRequirementType: "不限" / "限" / "不要" 等
 *  - nativePlaces: ['天津', '东三省', ...]（具体区域列表）
 *
 * 仅当 type 明确为 include/exclude 且 places 非空时返回结构化结果，否则 null。
 */
function normalizeHousehold(hometown: unknown): HouseholdRequirement | null {
  if (!hometown || typeof hometown !== 'object') return null;
  const h = hometown as any;
  const typeRaw =
    typeof h.nativePlaceRequirementType === 'string' ? h.nativePlaceRequirementType.trim() : '';
  const placesRaw = Array.isArray(h.nativePlaces) ? h.nativePlaces : [];
  const regions = placesRaw.filter(
    (p: unknown): p is string => typeof p === 'string' && p.trim().length > 0,
  );

  if (!typeRaw || regions.length === 0) return null;

  if (HOUSEHOLD_INCLUDE_TYPES.has(typeRaw) || /^(限|只要|只接受|仅)/.test(typeRaw)) {
    return { mode: 'include', regions };
  }
  if (HOUSEHOLD_EXCLUDE_TYPES.has(typeRaw) || /^(不要|不接受|排除)/.test(typeRaw)) {
    return { mode: 'exclude', regions };
  }
  return null;
}

const CERT_REQUIRED_BEFORE_INTERVIEW = /面试前|上岗前必须|必备|必须有|凭证.*入职/;
const CERT_BEFORE_ONBOARD = /入职前办|上岗前办|可入职后|录用后办|入职后/;
const CERT_NOT_REQUIRED = /不需要|无需|不必/;

/**
 * 从 healthCertGate + healthCertificateRequirement 文本派生健康证 enum。
 *
 * 优先级：明确字段 (healthCertGate) > 文本关键词推断 > 默认 unspecified。
 */
function normalizeHealthCert(gate: unknown, requirementText: unknown): HealthCertRequirement {
  if (gate === 'before_interview') return 'required_before_interview';
  if (gate === 'before_onboard') return 'required_before_onboard';

  const text = typeof requirementText === 'string' ? requirementText : '';
  if (!text || /未明确/.test(text)) return 'unspecified';

  if (CERT_NOT_REQUIRED.test(text)) return 'not_required';
  if (CERT_REQUIRED_BEFORE_INTERVIEW.test(text)) return 'required_before_interview';
  if (CERT_BEFORE_ONBOARD.test(text)) return 'required_before_onboard';

  // 含"健康证"但没指定时机 → 保守归为 before_onboard（多数岗位允许后办）
  if (/健康证/.test(text)) return 'required_before_onboard';

  return 'unspecified';
}

/**
 * 顶层入口：从 raw job + 可选的 policy 派生 HardRequirements enum。
 *
 * 当前只覆盖 gender / household / healthCert 三类高频硬约束。
 * 后续切片会扩展 age / student / education 等。
 *
 * policy 参数：调用方已经跑过 buildJobPolicyAnalysis 时直接传进来，避免重复构建。
 * 不传则只能从 job._policy（测试 fixture 通道）兜底，realtime 调用务必显式传入。
 */
export function extractHardRequirements(
  job:
    | {
        hiringRequirement?: any;
        _policy?: { normalizedRequirements?: any };
      }
    | null
    | undefined,
  policy?: { normalizedRequirements?: any } | null,
): HardRequirements {
  const req = job?.hiringRequirement;
  // sponge raw 用 basicPersonalRequirements；render/job-policy-parser 都按此 key 解构。
  const basic =
    (req && typeof req === 'object' && (req.basicPersonalRequirements || req.basic)) || {};
  const hometown = (req && typeof req === 'object' && req.requirementsForHometown) || null;
  const normalized = policy?.normalizedRequirements ?? job?._policy?.normalizedRequirements;

  return {
    gender: normalizeGender(basic.genderRequirement),
    household: normalizeHousehold(hometown),
    healthCert: normalizeHealthCert(
      normalized?.healthCertGate,
      normalized?.healthCertificateRequirement,
    ),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */
