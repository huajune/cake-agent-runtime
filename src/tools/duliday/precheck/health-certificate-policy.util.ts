import { normalizePolicyText } from '@tools/utils/job-policy-parser';

export type LocalHealthCertificateEligibilityStatus =
  | 'local_valid'
  | 'non_local_needs_confirmation'
  | 'accepts_local_application'
  | 'rejects_local_application'
  | 'unknown';

export interface LocalHealthCertificateEligibility {
  status: LocalHealthCertificateEligibilityStatus;
  spongeValue: 1 | 2 | 3 | null;
  recommendedQuestion?: string;
  reason: string;
}

function readText(value: unknown): string {
  if (typeof value === 'boolean') return value ? '有' : '无';
  if (typeof value === 'string') return normalizePolicyText(value);
  if (value && typeof value === 'object' && 'value' in value) {
    return readText((value as { value?: unknown }).value);
  }
  return '';
}

function isNonLocalCertificate(text: string): boolean {
  return /非本地|不是本地|外地|异地/.test(text) && /健康证/.test(text);
}

function isExplicitLocalCertificate(text: string): boolean {
  return !isNonLocalCertificate(text) && /本地.{0,4}健康证|健康证.{0,4}本地/.test(text);
}

function isAcceptance(text: string): boolean {
  return /无但接受办理健康证|可以办|可办|接受办|愿意办|能办/.test(text);
}

function isRejection(text: string): boolean {
  return /无且不接受办理健康证|不接受办|不办健康证|不愿意办|不能办/.test(text);
}

/**
 * 把“有无健康证”与“是否为应聘城市本地证”收敛成稳定业务状态。
 *
 * latestAnswer 是候选人本轮原话；historicalValues 是高置信/会话/长期事实。
 * 当历史已知“异地证”时，允许候选人用“可以/不接受”这类短答复完成二次确认。
 */
export function resolveLocalHealthCertificateEligibility(params: {
  latestAnswer?: unknown;
  normalizedKnownValue?: unknown;
  historicalValues?: unknown[];
}): LocalHealthCertificateEligibility {
  const latest = readText(params.latestAnswer);
  const historical = (params.historicalValues ?? []).map(readText).filter(Boolean);
  const hasHistoricalNonLocal = historical.some(isNonLocalCertificate);

  if (isNonLocalCertificate(latest)) {
    return {
      status: 'non_local_needs_confirmation',
      spongeValue: null,
      recommendedQuestion:
        '这个岗位需要应聘城市本地办理的健康证，你现在的是异地证。可以接受录用后重新办理一张本地健康证吗？',
      reason: '候选人明确持有异地健康证，异地证不能按“有”提交',
    };
  }

  if (hasHistoricalNonLocal && latest) {
    if (isRejection(latest) || /^(?:不接受|不愿意|不行|不可以|不办)$/.test(latest)) {
      return {
        status: 'rejects_local_application',
        spongeValue: 3,
        reason: '候选人有异地证但明确不接受重新办理本地证',
      };
    }
    if (isAcceptance(latest) || /^(?:可以|能|行|接受|愿意|没问题)$/.test(latest)) {
      return {
        status: 'accepts_local_application',
        spongeValue: 2,
        reason: '候选人有异地证并明确接受重新办理本地证',
      };
    }
  }

  const normalizedKnown = readText(params.normalizedKnownValue);
  const effective = latest || normalizedKnown;
  if (isRejection(effective)) {
    return {
      status: 'rejects_local_application',
      spongeValue: 3,
      reason: '候选人明确不接受办理本地健康证',
    };
  }
  if (isAcceptance(effective) || /无但接受办理/.test(effective)) {
    return {
      status: 'accepts_local_application',
      spongeValue: 2,
      reason: '候选人接受办理本地健康证',
    };
  }
  if (isExplicitLocalCertificate(effective) || /^\s*有\s*$|有健康证/.test(effective)) {
    return {
      status: 'local_valid',
      spongeValue: 1,
      reason: '候选人明确有本地健康证',
    };
  }
  if (historical.some(isNonLocalCertificate)) {
    return {
      status: 'non_local_needs_confirmation',
      spongeValue: null,
      recommendedQuestion:
        '这个岗位需要应聘城市本地办理的健康证，你现在的是异地证。可以接受录用后重新办理一张本地健康证吗？',
      reason: '历史事实显示候选人持有异地健康证，尚未确认是否重办',
    };
  }

  return {
    status: 'unknown',
    spongeValue: null,
    reason: '尚未收集候选人的本地健康证情况',
  };
}
