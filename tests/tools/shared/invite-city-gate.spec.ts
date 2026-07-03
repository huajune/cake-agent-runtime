import { evaluateInviteCityGate } from '@tools/shared/invite-city-gate';

describe('evaluateInviteCityGate', () => {
  it('allows when requested city matches session fact (normalized)', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '上海市',
      sessionCity: '上海',
      userTexts: [],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'session_fact' });
  });

  it('allows when candidate mentioned the city in user text', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '杭州',
      sessionCity: null,
      userTexts: ['你好', '我现在在杭州西湖区找兼职'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'user_text' });
  });

  it('user text mention wins over conflicting session fact (candidate moved city this turn)', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '杭州',
      sessionCity: '上海',
      userTexts: ['我下周搬到杭州了，帮我看看杭州的岗位'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'user_text' });
  });

  it('rejects with city_conflict and expectedCity when session fact disagrees', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '杭州',
      sessionCity: '上海市',
      userTexts: ['我想找兼职'],
    });
    expect(verdict).toEqual({
      decision: 'reject',
      reason: 'city_conflict',
      expectedCity: '上海',
    });
  });

  it('rejects with city_unverified when no source supports the city (badcase recvk28F1xrsKj)', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '杭州',
      sessionCity: null,
      userTexts: ['你好', '[图片消息] 一张门店照片'],
    });
    expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
  });

  it('does not run substring matching for single-character city input', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '沪',
      sessionCity: null,
      userTexts: ['我在沪上找活'],
    });
    expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
  });
});
