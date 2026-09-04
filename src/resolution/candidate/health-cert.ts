import { SPONGE_HEALTH_CERTIFICATE_MAPPING } from '@sponge/sponge.enums';
import type { CandidateParseResult } from './types';

export type HealthCertificateFact =
  | '有'
  | '无'
  | '非本地健康证'
  | '无但接受办理健康证'
  | '无且不接受办理健康证';

const CONSULTATION_TERMS = [
  '哪里',
  '哪儿',
  '何处',
  '什么地方',
  '怎么办',
  '怎么去办',
  '如何办',
  '能不能办',
  '可不可以办',
  '可以不可以办',
  '要不要办',
  '多少钱',
] as const;

export function hasHealthCertificateTopic(text: string): boolean {
  return /健康证|健康证明|健证|食品证|餐饮证|防疫证|健康检查|体检办证|体检|(?:有|没|无|不|办|考|带|需要|要)证/u.test(
    text,
  );
}

/**
 * 生产实测的歧义回填：`本地有效健康证，接受办理` 缺少决定状态的「有/无」。
 * 前半句像持证，后半句又像无证但愿意办理；任何一边都不能替候选人补字。
 * 只封这一个已观测句形，不扩大成通用健康证语义判官。
 */
export function isAmbiguousHealthCertificateAnswer(text: string): boolean {
  return text
    .normalize('NFKC')
    .split(/\r?\n/u)
    .some((line) => {
      const answer = line.replace(/^\s*有无本地健康证\s*[：:]\s*/u, '').trim();
      return /^(?:本地)?有效健康证[，,、\s]*(?:接受|愿意|可以|能)办(?:理)?[。！!]?$/u.test(answer);
    });
}

function splitClauses(message: string): string[] {
  return message
    .split(/(?<=[，,。！？?!；;\n])/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isQuestion(clause: string): boolean {
  return /[？?]|(?:吗|么|呢|吧|是吗|对吧)(?:[啊呀嘛])?(?:[！。])?$/u.test(clause);
}

function hasThirdPartySubject(clause: string): boolean {
  return /(?:公司|门店|你们|平台|单位|医院|社区)/u.test(clause) && /办(?:理)?/u.test(clause);
}

function isConsultation(clause: string): boolean {
  if (!clause.includes('健康证')) return false;
  if (CONSULTATION_TERMS.some((term) => clause.includes(term))) return true;
  const hasTopic = /免费|费用|收费|报销|补贴|线上|线下/u.test(clause);
  return (
    hasThirdPartySubject(clause) || (isQuestion(clause) && (hasTopic || /办(?:理)?/u.test(clause)))
  );
}

function declaredStatus(clause: string): HealthCertificateFact | null {
  if (
    /健康证.{0,6}(?:不是|非)本地|(?:外地|异地).{0,3}健康证|健康证.{0,4}(?:外地|异地)/u.test(clause)
  ) {
    return '非本地健康证';
  }
  if (
    /健康证\s*[：:]\s*(?:无|没有)(?:$|[\s，,。；;])/u.test(clause) ||
    /(?<!有)(?:没有(?:食品|餐饮|零售)?(?:类)?健康证|没健康证|无健康证)/u.test(clause) ||
    // 裸「没办过」必须与健康证同子句（PR #1000 评审 P0-6）：跨子句 latest-wins 下，
    // 「我有健康证，社保还没办过」的第二子句会把终值翻成「无」。紧凑答「没办过」
    // 经 terseAnswer/inherits 路径已被补上「健康证」前缀，同子句判据不损失召回。
    (/(?:食品|餐饮|零售)?(?:类)?健康证/u.test(clause) &&
      /(?<!有)(?:还?没办过|还没办)/u.test(clause))
  ) {
    return '无';
  }
  return null;
}

function extractClause(clause: string): HealthCertificateFact | null {
  const status = declaredStatus(clause);
  const thirdParty = hasThirdPartySubject(clause);

  if (CONSULTATION_TERMS.some((term) => clause.includes(term))) return status;

  if (
    !thirdParty &&
    /(?:拒绝|没法|无法|(?:不|没|未)(?:太|怎么|很)?(?:接受|愿意|想|打算|准备|考虑|会|能|可以)).{0,24}(?:去|再)?(?:体检.{0,10})?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|不(?:去|再)?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|健康证.{0,24}(?:拒绝|没法|无法|(?:不|没|未)(?:太|怎么|很)?(?:接受|愿意|想|打算|准备|考虑|会|能|可以)).{0,12}(?:去|再)?办(?:理)?/u.test(
      clause,
    )
  ) {
    return '无且不接受办理健康证';
  }

  if (isConsultation(clause)) return status;

  if (
    !thirdParty &&
    !isQuestion(clause) &&
    /(?<![不没未无非])(?:接受|愿意|可以|可|能|会|打算|准备|考虑|确定|后期|后面|之后|到时|到时候|入职前|上岗前).{0,24}(?:去|再)?(?:体检.{0,10})?办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|去体检.{0,12}办(?:理)?(?:一个|一张)?(?:食品|餐饮|零售)?(?:类)?健康证|健康证.{0,30}(?<![不没未无非])(?:接受|愿意|可以|能|会|打算|准备|考虑|确定).{0,12}(?:去|再)?办(?:理)?/u.test(
      clause,
    )
  ) {
    return '无但接受办理健康证';
  }

  if (status) return status;

  if (
    /健康证[^。！？\n]{0,8}(?:是吗|对吗|是吧|对吧|吗|么|吧|呢)|健康证[^。！？\n]{0,6}[？?]|(?:需要|要求|是不是要|要不要|用不用|必须|得)(?:先)?(?:有|办|持有?)?[^。！？\n]{0,8}健康证/u.test(
      clause,
    )
  ) {
    return null;
  }

  if (
    /有(?:食品|餐饮|零售)?(?:类)?健康证|本地.{0,4}健康证|健康证.{0,4}本地|(?:食品|餐饮|零售)?(?:类)?健康证.{0,6}(?:办好了?|办过|已办|办了|拿到|在手)/u.test(
      clause,
    )
  ) {
    return '有';
  }
  return null;
}

/** 单一健康证识别核心：否定优先、分句判定、疑问句不猜。 */
export function parseHealthCertificateMatch(
  text: string,
): CandidateParseResult<HealthCertificateFact> | null {
  // 收资问答里常见的紧凑回答不复述题目（“没办过，可以办”/“没有，不想办”）。
  // 只接受这两类封闭句形作为健康证字段回答，避免把任意“没有/可以办”误归因。
  const terseAnswer =
    /^\s*(?:没办过|还没办|没有)(?:[，,。；;\s]*(?:但|但是)?[，,。；;\s]*(?:可以|愿意|接受|能|不想|不愿意|不接受|不能)(?:去|再)?办)?[。！!]?\s*$/u;
  if (!hasHealthCertificateTopic(text) && !terseAnswer.test(text)) return null;
  const hasExplicitTopic = hasHealthCertificateTopic(text);
  const scopedText = hasExplicitTopic ? text : `健康证${text}`;
  let latest: HealthCertificateFact | null = null;
  let latestExcerpt: string | null = null;
  let topicSeen = false;
  let pending: string[] = [];

  for (const clause of splitClauses(scopedText)) {
    const mentions = clause.includes('健康证');
    const inherits =
      topicSeen &&
      (/(?:可以|可|能|会|愿意|接受|打算|准备|考虑|入职前|上岗前|后期|后面|之后|到时|到时候|公司|门店|你们|平台|单位|医院|社区).{0,16}(?:去|帮我|统一|负责)?办(?:理)?(?:一下|了)?(?:[?？!！。；;，,]|$)$/u.test(
        clause,
      ) ||
        /(?:外地|异地|(?:不是|非)本地)/u.test(clause));
    const scoped = mentions ? clause : inherits ? `健康证${clause}` : clause;
    if (mentions) topicSeen = true;
    const direct = extractClause(scoped);
    if (direct) {
      latest = direct;
      latestExcerpt = clause;
      pending = [];
      continue;
    }
    if (isConsultation(scoped)) {
      pending = [];
      continue;
    }
    pending.push(clause);
    const buffered = pending.join('');
    if (buffered.includes('健康证')) {
      const fact = extractClause(buffered);
      if (fact) {
        latest = fact;
        latestExcerpt = buffered;
        pending = [];
      }
    }
  }
  if (!latest || !latestExcerpt) return null;
  const excerpt =
    !hasExplicitTopic && latestExcerpt.startsWith('健康证')
      ? latestExcerpt.slice('健康证'.length)
      : latestExcerpt;
  return { value: latest, excerpt: excerpt.trim() };
}

export function toSpongeHealthCertCode(fact: HealthCertificateFact | null): 1 | 2 | 3 | null {
  if (fact === '有') return 1;
  if (fact === '无' || fact === '非本地健康证' || fact === '无但接受办理健康证') return 2;
  if (fact === '无且不接受办理健康证') return 3;
  return null;
}

export function parseHealthCert(text: string): CandidateParseResult<1 | 2 | 3> | null {
  const result = parseHealthCertificateMatch(text);
  const value = toSpongeHealthCertCode(result?.value ?? null);
  return result && value ? { value, excerpt: result.excerpt } : null;
}

export function normalizeHealthCertToId(value: string | number): 1 | 2 | 3 | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (numeric === 1 || numeric === 2 || numeric === 3) return numeric;
  for (const [id, label] of Object.entries(SPONGE_HEALTH_CERTIFICATE_MAPPING)) {
    if (label === value) return Number(id) as 1 | 2 | 3;
  }
  return toSpongeHealthCertCode(value as HealthCertificateFact);
}
