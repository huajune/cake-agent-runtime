import {
  CANDIDATE_CLAIM_FIELDS,
  CandidateClaimInputSchema,
  CANDIDATE_FACT_OPERATIONS,
} from '@resolution/evidence/claim.types';
import {
  FACT_CONFIDENCE_LEVELS,
  FACT_CONFIDENCE_LEVELS_DESC,
} from '@/memory/types/confidence-rank';
import {
  BrandIntentEntrySchema,
  SESSION_TERMINAL_STATES,
  SessionFactConfidenceSchema,
  WeworkSessionStateSchema,
} from '@/memory/types/session-facts.types';
import { RecommendedJobWelfareKindSchema } from '@resolution/job/types';
import { LONG_TERM_PREFERENCE_FIELD_KEYS } from '@/memory/types/long-term.types';
import { WELFARE_KINDS } from '@/tools/duliday/job-list/welfare-facts.util';
import {
  BRAND_FILTER_MODES,
  BRAND_INTENT_POLARITIES,
} from '@/resolution/brand/brand-resolution.types';

/**
 * 词表单一居所守卫（期 0：记忆与 Redis schema 族）。
 *
 * 本期收拢的词表都会被序列化进**发给模型的 JSON schema**，或参与 **Redis 落盘校验**。
 * 两类都不能靠 typecheck 兜底：
 * - 模型侧：枚举顺序变了模型先验就变，属无声改提示词；
 * - 落盘侧：读侧 z.enum 不认某档时 `getSessionState` 的 safeParse 失败会
 *   **整份会话状态归 EMPTY**（只留一条 warn），终态随之丢失。
 *
 * 故这里断言的是「取值与顺序逐一恒等」，不是「集合相等」。
 */

/** 取 zod enum 的实际取值序列（顺序敏感——这正是要锁的东西）。 */
function enumValues(schema: { options: readonly string[] }): string[] {
  return [...schema.options];
}

describe('词表单一居所 · 期 0', () => {
  describe('发给模型的 schema 取值与顺序不得漂移', () => {
    it('SessionFactConfidence 保持 high-first（历史顺序，非权威表的升序）', () => {
      expect(enumValues(SessionFactConfidenceSchema)).toEqual(['high', 'medium', 'low', 'unknown']);
      expect([...FACT_CONFIDENCE_LEVELS_DESC]).toEqual(['high', 'medium', 'low', 'unknown']);
    });

    it('降序元组与权威表成员集合恒等（只是顺序相反）', () => {
      expect([...FACT_CONFIDENCE_LEVELS_DESC].sort()).toEqual([...FACT_CONFIDENCE_LEVELS].sort());
      expect(FACT_CONFIDENCE_LEVELS_DESC.length).toBe(FACT_CONFIDENCE_LEVELS.length);
    });

    it('BrandIntentEntry.polarity 取值与顺序不变', () => {
      const polarity = BrandIntentEntrySchema.shape.polarity;
      expect(enumValues(polarity as unknown as { options: readonly string[] })).toEqual([
        'positive',
        'negative',
        'browse_all',
      ]);
      expect([...BRAND_INTENT_POLARITIES]).toEqual(['positive', 'negative', 'browse_all']);
    });

    it('CandidateClaimInput.operation 取值与顺序不变', () => {
      expect([...CANDIDATE_FACT_OPERATIONS]).toEqual(['set', 'correct', 'confirm', 'clear']);
      // field 早已是派生写法（本期不动），一并锁住防回退
      expect(CANDIDATE_CLAIM_FIELDS.length).toBeGreaterThan(0);
      expect(CandidateClaimInputSchema.shape.field).toBeDefined();
    });

    it('brandFilterMode 取值与顺序不变', () => {
      expect([...BRAND_FILTER_MODES]).toEqual(['enforce', 'exclude', 'clear', 'browse_all']);
    });
  });

  describe('福利档位（同属 Redis 落盘 schema，爆炸半径同终态）', () => {
    it('WELFARE_KINDS 取值与顺序不变', () => {
      expect([...WELFARE_KINDS]).toEqual(['company', 'allowance', 'self_or_none', 'unspecified']);
    });

    it.each([...WELFARE_KINDS])('welfareKind=%s 能通过记忆层 schema 校验', (kind) => {
      expect(RecommendedJobWelfareKindSchema.safeParse(kind).success).toBe(true);
    });

    it('未登记的福利档位被拒绝（证明校验非恒真）', () => {
      expect(RecommendedJobWelfareKindSchema.safeParse('not_a_kind').success).toBe(false);
    });
  });

  describe('Redis 落盘校验必须认识全部终态', () => {
    it('SESSION_TERMINAL_STATES 取值与顺序不变', () => {
      expect([...SESSION_TERMINAL_STATES]).toEqual([
        'booked',
        'handed_off',
        'rejected',
        'onboarded',
      ]);
    });

    it.each([...SESSION_TERMINAL_STATES])(
      'terminal=%s 能通过 WeworkSessionStateSchema 校验（漏一档即整份状态归空）',
      (terminal) => {
        const parsed = WeworkSessionStateSchema.partial().safeParse({ terminal });
        expect(parsed.success).toBe(true);
      },
    );

    it('未登记的终态被拒绝（证明校验确实生效，非恒真）', () => {
      const parsed = WeworkSessionStateSchema.partial().safeParse({ terminal: 'not_a_state' });
      expect(parsed.success).toBe(false);
    });
  });

  describe('长期意向渲染白名单穷尽性', () => {
    it('LONG_TERM_PREFERENCE_FIELD_KEYS 与 formatter labels 键集一致', () => {
      // labels 是 formatter 内部常量，这里从其唯一来源反向断言键集，
      // 真正的穷尽保护由 Record<LongTermPreferenceFieldKey, string> 在编译期完成。
      expect([...LONG_TERM_PREFERENCE_FIELD_KEYS]).toEqual([
        'city',
        'district',
        'location',
        'brands',
        'position',
        'schedule',
        'salary',
        'labor_form',
        'schedule_constraint',
        'delayed_intent',
        'available_after',
      ]);
    });
  });
});
