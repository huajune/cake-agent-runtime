import { scanGeoSignalsFromText } from '@resolution/geo';

/**
 * scanGeoSignalsFromText golden cases（方案 §8.4：三轮扫描编排平移，行为等价）。
 * 期望值与 Phase 0 提取层基线（tests/memory/high-confidence-facts.spec.ts）逐条对齐。
 */
describe('scanGeoSignalsFromText（三轮扫描编排）', () => {
  it('golden：浦东新区航头镇 → city 上海（unique_district_alias），districts 含 浦东新区+航头', () => {
    const scan = scanGeoSignalsFromText('浦东新区航头镇');
    expect(scan.city).toEqual({ value: '上海', evidence: 'unique_district_alias' });
    expect(scan.districts).toContain('浦东新区');
    expect(scan.districts).toContain('航头');
  });

  it('golden：上海浦东（直辖市开头紧接区）→ municipality_compact', () => {
    const scan = scanGeoSignalsFromText('上海浦东');
    expect(scan.city).toEqual({ value: '上海', evidence: 'municipality_compact' });
    expect(scan.districts).toEqual(['浦东']);
  });

  it('golden：我在青浦区 → unique_district_alias 推导上海', () => {
    const scan = scanGeoSignalsFromText('我在青浦区');
    expect(scan.city).toEqual({ value: '上海', evidence: 'unique_district_alias' });
    expect(scan.districts).toEqual(['青浦']);
  });

  it('golden：陆家嘴 → hotspot_alias 推导上海，locations 命中地标', () => {
    const scan = scanGeoSignalsFromText('我在陆家嘴上班');
    expect(scan.city).toEqual({ value: '上海', evidence: 'hotspot_alias' });
    expect(scan.locations).toEqual(['陆家嘴']);
  });

  it('golden：延吉市铁男 → 县级市白名单推导延边朝鲜族自治州', () => {
    const scan = scanGeoSignalsFromText('延吉市铁男');
    expect(scan.city).toEqual({ value: '延边朝鲜族自治州', evidence: 'unique_district_alias' });
    expect(scan.districts).toEqual(['延吉市']);
  });

  it('golden：余姚市 → 区县白名单"余姚"先命中推导宁波（方案 9.2 双轨现状）', () => {
    const scan = scanGeoSignalsFromText('我在余姚市这边');
    expect(scan.city).toEqual({ value: '宁波', evidence: 'unique_district_alias' });
    expect(scan.districts).toEqual(['余姚']);
  });

  it('golden：全国显式"XX市"兜底（昆山市 → explicit_city），裸名称不触发', () => {
    expect(scanGeoSignalsFromText('我在昆山市找工作').city).toEqual({
      value: '昆山',
      evidence: 'explicit_city',
    });
    expect(scanGeoSignalsFromText('我在昆山找工作').city).toBeNull();
  });

  it('golden：跨城歧义地名不推 city（万达广场/鼓楼区）', () => {
    expect(scanGeoSignalsFromText('万达广场').city).toBeNull();
    const scan = scanGeoSignalsFromText('鼓楼区附近');
    expect(scan.city).toBeNull();
    // 白名单外的区名走未覆盖段正则兜底，只标注不补 city
    expect(scan.districts).toEqual(['鼓楼']);
  });

  it('raw district 兜底剥离问候/所在前缀噪音', () => {
    const scan = scanGeoSignalsFromText('你好我在江夏区');
    expect(scan.city).toEqual({ value: '武汉', evidence: 'unique_district_alias' });
    expect(scan.districts).toContain('江夏');
  });

  it('三类命中位置信息随结果返回（供上游做紧凑表达判定）', () => {
    const scan = scanGeoSignalsFromText('上海浦东');
    expect(scan.cityHits).toEqual([{ key: '上海', start: 0, end: 2 }]);
    expect(scan.districtHits).toEqual([{ key: '浦东', start: 2, end: 4 }]);
    expect(scan.locationHits).toEqual([]);
  });
});
