import {
  FALLBACK_EXTRACTION,
  toSessionFacts,
  type EntityExtractionResult,
  type SessionFactConfidence,
  type SessionFacts,
} from '@memory/short-term/session-semantic/facts/facts.types';
import type { CandidateFactProducer } from '@resolution/evidence/claim.types';

export interface SessionFactsFixtureInput {
  interview_info?: Partial<EntityExtractionResult['interview_info']>;
  preferences?: Partial<EntityExtractionResult['preferences']>;
  reasoning?: string;
}

export interface SessionFactsFixtureMeta {
  confidence?: SessionFactConfidence;
  source?: CandidateFactProducer;
  evidence?: string;
  extractedAt?: string;
}

/**
 * 带信封的 SessionFacts fixture（存储态，= 生产唯一形态）。
 *
 * 提示词侧（PromptContext.sessionFacts / ComposeParams.sessionFacts）只接受
 * SessionFacts：裸 EntityExtractionResult 在 unwrapSessionFacts 里会**绕过**
 * minConfidence 比较原样透传，用裸态造 fixture 等于让置信度门在测试里恒为空操作
 * （core-flow-review 议题 1-1）。所有 prompt section 的 spec 一律经本 helper 构造。
 *
 * 默认 confidence=high，即"满足硬约束段阈值"；要验证门本身，传 confidence:'medium'
 * （city 的档位来自 CityFact.confidence，见 cityFixture）。
 */
export function sessionFactsOf(
  input: SessionFactsFixtureInput = {},
  meta: SessionFactsFixtureMeta = {},
): SessionFacts {
  return toSessionFacts(
    {
      interview_info: { ...FALLBACK_EXTRACTION.interview_info, ...input.interview_info },
      preferences: { ...FALLBACK_EXTRACTION.preferences, ...input.preferences },
      reasoning: input.reasoning ?? '',
    },
    {
      confidence: meta.confidence ?? 'high',
      source: meta.source ?? 'rule',
      evidence: meta.evidence ?? 'test fixture',
      ...(meta.extractedAt ? { extractedAt: meta.extractedAt } : {}),
    },
  );
}

/**
 * city 的置信度独立于其余字段（toSessionFacts 直接沿用 CityFact.confidence）。
 * 硬约束段/兼职群资源块的 high 门用它构造正反例。
 */
export function cityFixture(
  value: string,
  confidence: NonNullable<EntityExtractionResult['preferences']['city']>['confidence'] = 'high',
  evidence: NonNullable<
    EntityExtractionResult['preferences']['city']
  >['evidence'] = 'explicit_city',
): NonNullable<EntityExtractionResult['preferences']['city']> {
  return { value, confidence, evidence };
}
