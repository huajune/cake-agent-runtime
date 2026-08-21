import { evaluateInviteCityGate } from '@tools/invite/invite-city-gate';
import type { InviteCityGateInput } from '@tools/invite/invite-city-gate';
import { inferCitiesFromGeoSignals } from '@resolution/evidence/producers/city';

function evaluateGate(input: Omit<InviteCityGateInput, 'geoSignalCities'>) {
  const userTexts = input.userTexts.filter((text): text is string => typeof text === 'string');
  return evaluateInviteCityGate({
    ...input,
    geoSignalCities: inferCitiesFromGeoSignals(userTexts),
  });
}

describe('evaluateInviteCityGate', () => {
  it('rejects city_unverified when the requested city normalizes to null (P2-1 NPE guard)', () => {
    // normalizeCityName 对空/纯后缀输入返回 null；不判空会 NPE 并被外层 catch
    // 误分类成 INVITE_API_FAILED。
    for (const requestedCity of ['', '  ', '市']) {
      expect(
        evaluateGate({ requestedCity, sessionCity: '上海', userTexts: ['我在上海'] }).decision,
      ).toBe('reject');
    }
    expect(evaluateGate({ requestedCity: '', sessionCity: null, userTexts: [] })).toEqual({
      decision: 'reject',
      reason: 'city_unverified',
    });
  });

  it('allows when requested city matches session fact (normalized)', () => {
    const verdict = evaluateGate({
      requestedCity: '上海市',
      sessionCity: '上海',
      userTexts: [],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'session_fact' });
  });

  it('allows when candidate mentioned the city in user text', () => {
    const verdict = evaluateGate({
      requestedCity: '杭州',
      sessionCity: null,
      userTexts: ['你好', '我现在在杭州西湖区找兼职'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'user_text' });
  });

  it('user text mention wins over conflicting session fact (candidate moved city this turn)', () => {
    const verdict = evaluateGate({
      requestedCity: '杭州',
      sessionCity: '上海',
      userTexts: ['我下周搬到杭州了，帮我看看杭州的岗位'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'user_text' });
  });

  it('rejects with city_conflict and expectedCity when session fact disagrees', () => {
    const verdict = evaluateGate({
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
    const verdict = evaluateGate({
      requestedCity: '杭州',
      sessionCity: null,
      userTexts: ['你好', '[图片消息] 一张门店照片'],
    });
    expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
  });

  it('allows via district inference when candidate reported an unambiguous district (badcase 6a5d8f92: 顺义区马坡镇)', () => {
    const verdict = evaluateGate({
      requestedCity: '北京',
      sessionCity: null,
      userTexts: ['咱们还招人吗', '我在北辰墅院', '顺义区马坡镇'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows 深圳 via district inference for 宝安区 (badcase 6k74okcw: 宝安区桥头新区仍被反问城市)', () => {
    const verdict = evaluateGate({
      requestedCity: '深圳',
      sessionCity: null,
      userTexts: ['我在宝安区桥头新区', '桥头地铁站A出口附近'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows 广州 via district inference for 黄埔区 (badcase bubv5rh9: 黄埔区被当上海黄浦区)', () => {
    const verdict = evaluateGate({
      requestedCity: '广州',
      sessionCity: null,
      userTexts: ['黄埔区'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('does not infer 广州 from Shanghai 黄浦 (different character, stays unverified)', () => {
    const verdict = evaluateGate({
      requestedCity: '广州',
      sessionCity: null,
      userTexts: ['我在黄浦区'],
    });
    expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
  });

  it('allows via district inference for town-level mention inside location-share render text (badcase 6a5d96de: 房山定位)', () => {
    const verdict = evaluateGate({
      requestedCity: '北京',
      sessionCity: null,
      userTexts: ['[位置分享] 房山区大董村（房山区大窦路支路） [经纬度:39.717,116.059]'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows via district inference for 浦东/川沙 → 上海 (badcase 沫慕晏)', () => {
    const verdict = evaluateGate({
      requestedCity: '上海市',
      sessionCity: null,
      userTexts: ['浦东', '川沙', '日结的'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('district inference wins over conflicting session fact (district reported this session is current location)', () => {
    const verdict = evaluateGate({
      requestedCity: '北京',
      sessionCity: '上海',
      userTexts: ['我现在搬到顺义了'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows via district inference for 青岛崂山 (badcase recvqhLOPwv0m9: 崂山区松岭路)', () => {
    const verdict = evaluateGate({
      requestedCity: '青岛',
      sessionCity: null,
      userTexts: ['招收兼职吗？', '崂山区松岭路', '在北宅'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('市南/市北 only count with the 区 suffix (substring safety)', () => {
    expect(
      evaluateGate({
        requestedCity: '青岛',
        sessionCity: null,
        userTexts: ['我在超市南边等你'],
      }),
    ).toEqual({ decision: 'reject', reason: 'city_unverified' });
    expect(
      evaluateGate({
        requestedCity: '青岛',
        sessionCity: null,
        userTexts: ['我住市北区'],
      }),
    ).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('accepts business-biased district names (朝阳/通州) after unifying on @resolution/geo whitelist', () => {
    // 2026-07-28 裁定翻转：原私表按"全国无重名"拒收朝阳（长春）/通州（南通），
    // 但提取层对同一句话本就按业务偏置写 city=北京 高置信事实，gate 下一轮凭
    // session_fact 放行——原"更严"仅同轮内生效，属幻觉严格性。统一对齐提取层口径。
    const verdict = evaluateGate({
      requestedCity: '北京',
      sessionCity: null,
      userTexts: ['我在朝阳这边', '通州也行'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows via district inference for 黄埔→广州 / 宝安→深圳 (unified geo whitelist)', () => {
    expect(
      evaluateGate({
        requestedCity: '广州',
        sessionCity: null,
        userTexts: ['我在黄埔区这边找工作'],
      }),
    ).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
    expect(
      evaluateGate({
        requestedCity: '深圳',
        sessionCity: null,
        userTexts: ['宝安这边有吗'],
      }),
    ).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('allows via landmark inference (陆家嘴→上海, high-confidence place alias via geo scan)', () => {
    const verdict = evaluateGate({
      requestedCity: '上海',
      sessionCity: null,
      userTexts: ['我在陆家嘴上班，想找附近兼职'],
    });
    expect(verdict).toEqual({ decision: 'allow', matchedBy: 'district_inference' });
  });

  it('district inference for a different city is not evidence for the requested city', () => {
    const verdict = evaluateGate({
      requestedCity: '杭州',
      sessionCity: null,
      userTexts: ['我之前在浦东做过'],
    });
    expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
  });

  it('does not run substring matching for single-character city input', () => {
    const verdict = evaluateGate({
      requestedCity: '沪',
      sessionCity: null,
      userTexts: ['我在沪上找活'],
    });
    expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
  });

  describe('turn_geocode 档（同轮 geocode 确权，v10.31.0 残留同轮空档修复）', () => {
    it('allows when this turn geocode uniquely resolved the requested city (badcase 6a680c63: 高明万悦天地→佛山)', () => {
      const verdict = evaluateGate({
        requestedCity: '佛山市',
        sessionCity: null,
        userTexts: ['高明万悦天地这边有招人吗'],
        turnResolvedCities: ['佛山市'],
      });
      expect(verdict).toEqual({ decision: 'allow', matchedBy: 'turn_geocode' });
    });

    it('normalizes 市 suffix between requested and resolved city (badcase 6a66d0f8: 莘庄→上海)', () => {
      // 原 badcase 文本"莘庄附近…"在统一 geo 白名单后会先被 district_inference
      // 命中（莘庄是高置信地标）；此处改用不撞白名单的文本，保持本用例
      // 专测 turn_geocode 档的"市"后缀归一化路径。
      const verdict = evaluateGate({
        requestedCity: '上海市',
        sessionCity: null,
        userTexts: ['这附近有日结工作吗？'],
        turnResolvedCities: ['上海'],
      });
      expect(verdict).toEqual({ decision: 'allow', matchedBy: 'turn_geocode' });
    });

    it('turn geocode wins over conflicting session fact (fresh location clue this turn)', () => {
      const verdict = evaluateGate({
        requestedCity: '佛山',
        sessionCity: '上海',
        userTexts: ['高明万悦天地这边有招人吗'],
        turnResolvedCities: ['佛山市'],
      });
      expect(verdict).toEqual({ decision: 'allow', matchedBy: 'turn_geocode' });
    });

    it('a resolved city different from the requested one is not evidence', () => {
      const verdict = evaluateGate({
        requestedCity: '广州',
        sessionCity: null,
        userTexts: ['高明万悦天地这边有招人吗'],
        turnResolvedCities: ['佛山市'],
      });
      expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
    });

    it('null/empty anchors are ignored safely', () => {
      const verdict = evaluateGate({
        requestedCity: '杭州',
        sessionCity: null,
        userTexts: [],
        turnResolvedCities: [null, undefined, ''],
      });
      expect(verdict).toEqual({ decision: 'reject', reason: 'city_unverified' });
    });
  });
});
