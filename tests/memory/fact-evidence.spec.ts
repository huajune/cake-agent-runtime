import { MAX_FACT_EVIDENCE_CHARS, truncateEvidence } from '@memory/fact-evidence';
import { sessionFactValue } from '@memory/short-term/short-term.types';
import {
  UserProfileFactValueSchema,
  userProfileFactValue,
} from '@memory/long-term/long-term.types';

const cleanup = require('../../scripts/cleanup-profile-evidence.js') as {
  truncateEvidence: typeof truncateEvidence;
  cleanProfileFacts: (facts: Record<string, unknown>) => Record<string, unknown> | null;
};

describe('fact evidence storage budget', () => {
  it.each(['a', '证', '😀'])('含省略号不超过 200 码点且重复截断稳定：%s', (character) => {
    const boundary = character.repeat(MAX_FACT_EVIDENCE_CHARS);
    expect(truncateEvidence(` ${boundary} `)).toBe(boundary);
    for (const length of [201, 509]) {
      const actual = truncateEvidence(character.repeat(length));
      expect(Array.from(actual)).toHaveLength(200);
      expect(actual).toBe(`${character.repeat(199)}…`);
      expect(truncateEvidence(actual)).toBe(actual);
      expect(cleanup.truncateEvidence(character.repeat(length))).toBe(actual);
    }
  });

  it('零/一字预算不会越界', () => {
    expect(truncateEvidence('abc', 0)).toBe('');
    expect(truncateEvidence('abc', 1)).toBe('…');
  });

  it('短期/长期构造器和长期读边界均封顶，保留事实值及来源', () => {
    const meta = {
      confidence: 'medium' as const,
      source: 'candidate_quote' as const,
      evidence: '原'.repeat(509),
    };
    const session = sessionFactValue(null, meta);
    const profile = userProfileFactValue('100', { ...meta, originBotId: 'bot-1' });
    expect(session).toEqual({ value: null, ...meta, evidence: `${'原'.repeat(199)}…` });
    expect(profile.value).toBe('100');
    expect(profile.originBotId).toBe('bot-1');
    expect(profile.evidence).toHaveLength(200);
    expect(UserProfileFactValueSchema.parse({ ...profile, evidence: meta.evidence })).toEqual(
      profile,
    );
    expect(cleanup.cleanProfileFacts({ city: { ...session, evidence: meta.evidence } })).toEqual({
      city: session,
    });
    expect(cleanup.cleanProfileFacts({ city: session })).toBeNull();
  });
});
