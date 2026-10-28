import { isValidExtractedEvidence, normalizeFactEvidence } from '@memory/fact-evidence';
import { sessionFactValue } from '@memory/short-term/short-term.types';
import {
  UserProfileFactValueSchema,
  userProfileFactValue,
} from '@memory/long-term/long-term.types';
import { cleanMemoryFacts } from '@memory/memory-integrity';
import { admitPreferenceEvidence } from '@memory/short-term/extraction-evidence';

describe('field evidence admission and lossless storage', () => {
  it.each(['证', '😀'])('模型预算按Unicode码点校验，不截断：%s', (char) => {
    expect(isValidExtractedEvidence(char.repeat(200))).toBe(true);
    expect(isValidExtractedEvidence(char.repeat(201))).toBe(false);
    expect(normalizeFactEvidence(char.repeat(509))).toBe(char.repeat(509));
  });

  it('拒绝超长或缺证据的字段增量，保留其他字段和末尾否定条件', () => {
    const preferences = { schedule: '晚上', salary: '25', location: ['新业坊'], city: '上海' };
    const evidence = '本人只考虑新业坊；朋友住浦东，不代表本人接受浦东。';
    const result = admitPreferenceEvidence(preferences, {
      schedule: '条件'.repeat(200) + '但不接受夜班',
      salary: '',
      location: evidence,
    });
    expect(preferences).toEqual({ schedule: null, salary: null, location: ['新业坊'], city: null });
    expect(result.rejected).toEqual(['schedule', 'salary', 'city']);
    expect(result.evidence).toEqual({ location: evidence });
  });

  it('短期构造、长期构造、读取清理保留长原话末尾的否定和条件', () => {
    const evidence = '原始对话。'.repeat(80) + '但周末不能来，只有办证后才能入职。';
    const meta = { confidence: 'medium' as const, source: 'candidate_quote' as const, evidence };
    expect(sessionFactValue(null, meta)).toEqual({ value: null, ...meta });
    const fact = userProfileFactValue('100', { ...meta, originBotId: 'bot-1' });
    expect(fact.evidence).toBe(evidence);
    expect(UserProfileFactValueSchema.parse(fact)).toEqual(fact);
    expect(cleanMemoryFacts({ weight: fact })).toEqual({ weight: fact });
  });
});
