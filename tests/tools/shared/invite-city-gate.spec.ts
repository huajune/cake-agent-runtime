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

  it('allows via district inference when candidate reported an unambiguous district (badcase 6a5d8f92: 顺义区马坡镇)', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '北京',
      sessionCity: null,
      userTexts: ['咱们还招人吗', '我在北辰墅院', '顺义区马坡镇'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows via district inference for town-level mention inside location-share render text (badcase 6a5d96de: 房山定位)', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '北京',
      sessionCity: null,
      userTexts: ['[位置分享] 房山区大董村（房山区大窦路支路） [经纬度:39.717,116.059]'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows via district inference for 浦东/川沙 → 上海 (badcase 沫慕晏)', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '上海市',
      sessionCity: null,
      userTexts: ['浦东', '川沙', '日结的'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('district inference wins over conflicting session fact (district reported this session is current location)', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '北京',
      sessionCity: '上海',
      userTexts: ['我现在搬到顺义了'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('does not treat ambiguous district names (朝阳/通州) as provenance', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '北京',
      sessionCity: null,
      userTexts: ['我在朝阳这边', '通州也行'],
    });
    expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
  });

  it('district inference for a different city is not evidence for the requested city', () => {
    const verdict = evaluateInviteCityGate({
      requestedCity: '杭州',
      sessionCity: null,
      userTexts: ['我之前在浦东做过'],
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
