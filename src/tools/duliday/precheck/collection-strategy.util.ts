/**
 * 候选人对话信号检测（抗收资 / 坚持真名）+ 收资策略推荐。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）：
 * - extractMessageText / getRecentUserMessages：从 raw messages 抽出最近 N 条用户文本
 * - detectRealNameInsistence：候选人坚持"这就是真名"（少数民族真名场景）
 * - detectCollectionResistance：候选人对填资料有抗拒/不耐烦（"太麻烦/不想填"）
 * - buildCollectionStrategy：根据 missingFields + 抗拒信号决定 full_template vs progressive
 */

import { normalizePolicyText } from '@tools/utils/job-policy-parser';
import { API_BOOKING_USER_REQUIRED_FIELDS } from '@tools/duliday/booking/job-booking.contract';
import { orderFields } from '@tools/duliday/precheck/checklist.util';
import { dedupeStrings } from '@tools/duliday/precheck/field-normalize.util';

const COLLECTION_RESISTANCE_PATTERNS = [
  { label: '这么多信息', pattern: /这么多(信息|资料|内容|东西|问题)/ },
  { label: '问/填这么多', pattern: /(问|填|提供|发|写).{0,4}这么多/ },
  { label: '太麻烦', pattern: /(太|好)?麻烦(了)?/ },
  { label: '不想填', pattern: /不想(填|提供|发|写)/ },
  { label: '不填了', pattern: /不(填|发|给)了/ },
  { label: '懒得填', pattern: /懒得(填|发|写)/ },
  { label: '烦死了', pattern: /烦死了|烦得很/ },
  { label: '滚犊子', pattern: /滚犊子|滚蛋/ },
] as const;

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((item) => extractMessageText(item))
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }

  return '';
}

export function getRecentUserMessages(messages: unknown[], limit = 3): string[] {
  const texts = messages
    .map((message) => {
      if (!message || typeof message !== 'object') return null;
      const record = message as Record<string, unknown>;
      if (record.role !== 'user') return null;
      const text = normalizePolicyText(extractMessageText(record.content));
      return text || null;
    })
    .filter((text): text is string => Boolean(text));

  return texts.slice(-limit);
}

/**
 * 候选人坚持"姓名就是真实姓名"的信号。
 *
 * 历史 badcase slg3jqi9：候选人本名"布买日也木"（少数民族 5 字真名），被
 * isLikelyRealChineseName 的 2-4 字汉字白名单一律拒；候选人回复"这个就是真实姓名"
 * 坚持后，Agent 仍按 nameFieldGuard 反复要求改名，最终候选人无奈给"小布"小名才报上。
 *
 * 出现此信号时，nameFieldGuard 应升级到"必须转人工"模式，由招募经理人工补录长姓名。
 */
const REAL_NAME_INSISTENCE_PATTERNS: readonly RegExp[] = [
  /这(?:就|确实|的确)?是(?:我的)?(?:真|本)(?:名|实姓名)/,
  /(?:这|我)的全名(?:就|确实|的确)?是/,
  /真名(?:就|确实|的确)?是/,
  /(?:我|本人)就(?:叫|是)/,
  /没起过(?:中文|汉)名/,
  /身份证上(?:就|确实|的确)?是/,
  /(?:少数民族|藏族|维吾尔|蒙古|回族|彝族|哈萨克)/,
];

export function detectRealNameInsistence(messages: unknown[]): boolean {
  const recent = getRecentUserMessages(messages, 6);
  for (const msg of recent) {
    for (const pattern of REAL_NAME_INSISTENCE_PATTERNS) {
      if (pattern.test(msg)) return true;
    }
  }
  return false;
}

export function detectCollectionResistance(messages: unknown[]): {
  detected: boolean;
  matchedSignals: string[];
  latestUserMessage: string | null;
} {
  const recentUserMessages = getRecentUserMessages(messages);
  const latestUserMessage = recentUserMessages[recentUserMessages.length - 1] ?? null;

  if (!latestUserMessage) {
    return {
      detected: false,
      matchedSignals: [],
      latestUserMessage: null,
    };
  }

  const matchedSignals = dedupeStrings(
    recentUserMessages.flatMap((message) =>
      COLLECTION_RESISTANCE_PATTERNS.filter(({ pattern }) => pattern.test(message)).map(
        ({ label }) => label,
      ),
    ),
  );

  return {
    detected: matchedSignals.length > 0,
    matchedSignals,
    latestUserMessage,
  };
}

export function buildCollectionStrategy(params: {
  missingFields: string[];
  resistanceSignals: string[];
}): {
  candidateResistanceDetected: boolean;
  recommendedMode: 'full_template' | 'progressive';
  reason: string;
  starterFields: string[];
  remainingFields: string[];
} {
  const orderedMissingFields = orderFields(params.missingFields);
  const coreMissingFields = orderFields(
    orderedMissingFields.filter((field) =>
      (API_BOOKING_USER_REQUIRED_FIELDS as readonly string[]).includes(field),
    ),
  );
  const starterFields =
    coreMissingFields.length > 0
      ? coreMissingFields
      : orderedMissingFields.slice(0, Math.min(2, orderedMissingFields.length));
  const remainingFields = orderedMissingFields.filter((field) => !starterFields.includes(field));
  const candidateResistanceDetected = params.resistanceSignals.length > 0;

  return {
    candidateResistanceDetected,
    recommendedMode: candidateResistanceDetected ? 'progressive' : 'full_template',
    reason: candidateResistanceDetected
      ? `候选人当前对收资有抗拒或不耐烦信号（${params.resistanceSignals.join('、')}），先共情解释，再从 starterFields 开始逐步收集`
      : '候选人当前没有明显收资阻力，正常场景可直接参考 templateText 一次性收集当前岗位需要的信息',
    starterFields,
    remainingFields,
  };
}
