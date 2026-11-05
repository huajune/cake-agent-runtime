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
    expect(result.issues).toEqual([
      { field: 'schedule', reason: 'over_budget', characters: 406 },
      { field: 'salary', reason: 'empty', characters: 0 },
      { field: 'city', reason: 'missing', characters: 0 },
    ]);
  });

  it('已有偏好和等价班次 patch 是无变化；缺证据不报拒绝，也不覆盖旧证据', () => {
    const previous = {
      city: '上海',
      location: ['新业坊', '静安寺'],
      schedule_constraint: {
        includeAnyTags: ['evening', 'night'],
        maxDaysPerWeek: 3,
      },
    };
    const delta = {
      city: '上海',
      location: ['静安寺', '新业坊'],
      schedule_constraint: { includeAnyTags: ['night', 'evening', 'night'] },
    };
    const result = admitPreferenceEvidence(delta, undefined, {}, previous);
    expect(delta).toEqual({ city: null, location: null, schedule_constraint: null });
    expect(result.rejected).toEqual([]);
    expect(result.unchanged).toEqual(['city', 'location', 'schedule_constraint']);
  });

  it('有效的专用原话可替代空通用证据，后续仍由班次原话核验决定入库', () => {
    const delta = { schedule_constraint: { maxDaysPerWeek: 2 } };
    const result = admitPreferenceEvidence(
      delta,
      { schedule_constraint: '' },
      { schedule_constraint: '一周最多两天' },
    );
    expect(result.rejected).toEqual([]);
    expect(result.evidence).toEqual({ schedule_constraint: '一周最多两天' });
    expect(delta.schedule_constraint).toEqual({ maxDaysPerWeek: 2 });
  });

  it('撤销已有条件属于真实增量，没有证据必须拒绝', () => {
    const previous = { schedule_constraint: { availableWindow: { start: '20:00' } } };
    const delta = { schedule_constraint: { availableWindow: null } };
    expect(admitPreferenceEvidence(delta, undefined, {}, previous).issues).toEqual([
      { field: 'schedule_constraint', reason: 'missing', characters: 0 },
    ]);
    const verified = { schedule_constraint: { availableWindow: null } };
    expect(
      admitPreferenceEvidence(verified, undefined, { schedule_constraint: '时间不限了' }, previous)
        .rejected,
    ).toEqual([]);
    expect(verified.schedule_constraint).toEqual({ availableWindow: null });
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
