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

  it('沈阳批次：我在浑南区 → unique_district_alias 推导沈阳（badcase 6a671722）', () => {
    const scan = scanGeoSignalsFromText('我在浑南区');
    expect(scan.city).toEqual({ value: '沈阳', evidence: 'unique_district_alias' });
    expect(scan.districts).toContain('浑南');
  });

  it('佛山批次：高明万悦天地这边有招人吗 → 高明区带后缀才推导（badcase 6a680c63）', () => {
    // "高明"是常用词（聪明），裸词不推导；带"区"后缀才确定性映射
    expect(scanGeoSignalsFromText('你真高明').city).toBeNull();
    const scan = scanGeoSignalsFromText('我在高明区这边');
    expect(scan.city).toEqual({ value: '佛山', evidence: 'unique_district_alias' });
  });

  it('佛山批次：南海区/三水区带后缀推导，裸词不误命中（南海=海域语料）', () => {
    expect(scanGeoSignalsFromText('南海诸岛').city).toBeNull();
    expect(scanGeoSignalsFromText('我在南海区万达').city).toEqual({
      value: '佛山',
      evidence: 'unique_district_alias',
    });
  });

  it('裸名城市补录：沈阳/佛山 直接抽 city（explicit_city）', () => {
    expect(scanGeoSignalsFromText('我在沈阳找工作').city).toEqual({
      value: '沈阳',
      evidence: 'explicit_city',
    });
    expect(scanGeoSignalsFromText('佛山这边有单吗').city).toEqual({
      value: '佛山',
      evidence: 'explicit_city',
    });
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

  it('自我介绍中的姓名不作为地理证据，后续真实位置仍可抽取', () => {
    const scan = scanGeoSignalsFromText(
      '[图片消息]\n[引用 招聘经理：怎么称呼]\n我是黄梅\n我现在在青浦区\n[消息发送时间：2026-08-13 10:24:32]',
    );
    expect(scan.city).toEqual({ value: '上海', evidence: 'unique_district_alias' });
    expect(scan.districts).toContain('青浦');
    expect(scan.districts).not.toContain('黄梅');
  });

  it('golden：余姚市 → 区县白名单"余姚"先命中推导宁波（方案 9.2 双轨现状）', () => {
    const scan = scanGeoSignalsFromText('我在余姚市这边');
    expect(scan.city).toEqual({ value: '宁波', evidence: 'unique_district_alias' });
    expect(scan.districts).toEqual(['余姚']);
  });

  it('golden：全国显式"XX市"兜底（温岭市 → explicit_city），裸名称不触发', () => {
    expect(scanGeoSignalsFromText('我在温岭市找工作').city).toEqual({
      value: '温岭',
      evidence: 'explicit_city',
    });
    expect(scanGeoSignalsFromText('我在温岭找工作').city).toBeNull();
  });

  it('昆山市 → 县级市补录映射推导苏州市（Phase 3 补录，与延吉同构）；裸名称不触发', () => {
    expect(scanGeoSignalsFromText('我在昆山市找工作').city).toEqual({
      value: '苏州市',
      evidence: 'unique_district_alias',
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

  /**
   * 通名后缀拒绝：裸词 indexOf 不得把"路/街/公园"专名里的区名字样
   * 当成行政区命中并把一个地址拆成两城。
   */
  describe('通名后缀拒绝（生产冲突样本回归）', () => {
    it('mpr 223305/223342/223354：上海位置分享含"宝安公路"，不得命中深圳宝安区', () => {
      const scan = scanGeoSignalsFromText('宝山区新顾村大家园(C区)（宝山区宝安公路）');
      expect(scan.city).toEqual({ value: '上海', evidence: 'unique_district_alias' });
      expect(scan.districts).not.toContain('宝安');
    });

    it('mpr 223843：北京位置分享含"宝山中街"，不得命中上海宝山区', () => {
      const scan = scanGeoSignalsFromText('海淀区田村阜石路93号院(宝山中街北)（海淀区宝山中街）');
      expect(scan.city).toEqual({ value: '北京', evidence: 'unique_district_alias' });
      expect(scan.districts).not.toContain('宝山');
    });

    it('mpr 225370：深圳罗湖的"洪湖公园/洪湖路"不得命中荆州洪湖', () => {
      expect(scanGeoSignalsFromText('罗湖区洪湖公园附近').city).toEqual({
        value: '深圳',
        evidence: 'unique_district_alias',
      });
      expect(scanGeoSignalsFromText('罗湖区洪湖路').districts).not.toContain('洪湖');
    });

    it('城市裸名同样收口："上海路"（南京路名）不得推导出上海', () => {
      expect(scanGeoSignalsFromText('上海路').city).toBeNull();
    });

    it('行政后缀放行：区/街道 不是通名，裸词与"我在XX"召回不受影响', () => {
      // "街道"必须放行（街(?!道)），否则青浦街道会被误拒
      expect(scanGeoSignalsFromText('我在青浦街道').city).toEqual({
        value: '上海',
        evidence: 'unique_district_alias',
      });
      expect(scanGeoSignalsFromText('我在宝山').city).toEqual({
        value: '上海',
        evidence: 'unique_district_alias',
      });
      expect(scanGeoSignalsFromText('我在宝山区').city).toEqual({
        value: '上海',
        evidence: 'unique_district_alias',
      });
    });

    it('地标轮不开拒绝：陆家嘴/望京后接通名仍应命中', () => {
      expect(scanGeoSignalsFromText('陆家嘴广场').city).toEqual({
        value: '上海',
        evidence: 'hotspot_alias',
      });
      expect(scanGeoSignalsFromText('望京站').city).toEqual({
        value: '北京',
        evidence: 'hotspot_alias',
      });
    });

    it('地标表收紧批（2026-08-14）：通名/连锁品牌不再解析出城市', () => {
      // 三周 shadow 实证的四个泛名 + 同类不变式违反项，一律移入 DIRTY_ALIAS_EXCLUSIONS。
      // 期望是"解析不出城市"（交上游澄清），而不是"解析成别的城市"。
      for (const text of ['国贸', '五道口', '王家湾', '瑶湖', '世纪公园', '临港', '九方']) {
        expect(scanGeoSignalsFromText(text).city).toBeNull();
      }
    });
  });
});
