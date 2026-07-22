import {
  COUNTY_LEVEL_CITY_TO_PREFECTURE,
  detectGeoSignalConflict,
  DISTRICT_TO_CITY,
  LOCATION_TO_CITY,
  NATIONAL_CITY_SUFFIX_TO_CITY,
  resolveCityFromDistrict,
  resolveCityFromGeoSignals,
  resolveParentAdministrativeArea,
  SUPPORTED_CITY_PREFIXES,
} from '@resolution/geo';

describe('resolution/geo admin（Phase 0 golden cases 平移 + §8.3 resolver）', () => {
  describe('resolveCityFromDistrict（唯一区县白名单）', () => {
    it(
      'golden：朝阳区 → 北京（刻意业务偏置：北京/长春朝阳区、辽宁朝阳市均不在业务区域，' +
        'Phase 4 国家数据交叉校验时须以 override 豁免，见方案 9.2）',
      () => {
        expect(resolveCityFromDistrict('朝阳区')).toBe('北京');
        expect(resolveCityFromDistrict('朝阳')).toBe('北京');
      },
    );

    it('golden：余姚/慈溪 → 宁波（业务足迹县级市走区县白名单）', () => {
      expect(resolveCityFromDistrict('余姚')).toBe('宁波');
      expect(resolveCityFromDistrict('慈溪')).toBe('宁波');
    });

    it('golden：延吉市 → 延边朝鲜族自治州（县级市映射并入区县表）', () => {
      expect(resolveCityFromDistrict('延吉市')).toBe('延边朝鲜族自治州');
    });

    it('真跨城歧义区名不在白名单，city 不解析（鼓楼：南京/福州/开封/徐州同名）', () => {
      expect(resolveCityFromDistrict('鼓楼区')).toBeNull();
      expect(resolveCityFromDistrict('鼓楼')).toBeNull();
    });
  });

  describe('resolveCityFromGeoSignals（多信号推导）', () => {
    it('district 优先于 location，命中即带 evidence', () => {
      expect(resolveCityFromGeoSignals(['青浦区'], null)).toEqual({
        value: '上海',
        evidence: 'unique_district_alias',
      });
      expect(resolveCityFromGeoSignals(null, ['陆家嘴'])).toEqual({
        value: '上海',
        evidence: 'hotspot_alias',
      });
      expect(resolveCityFromGeoSignals(['鼓楼区'], null)).toBeNull();
    });

    it('golden（现状=先命中先赢）：多信号指向不同城市时静默取第一个命中，无冲突出口', () => {
      // 现网实证（方案 §3）：badcase xnp1u820 "成都的 + 静安区"。Phase 3 冲突检测
      // 将把此类案例以 shadow 档落 GeoQueryMeta 观测（返回值不变），enforce 切换
      // 需 shadow 观测 1~2 周后人工决策——本用例锁定在那之前行为不漂移。
      expect(resolveCityFromGeoSignals(['静安区'], ['光谷'])).toEqual({
        value: '上海',
        evidence: 'unique_district_alias',
      });
    });
  });

  describe('resolveParentAdministrativeArea（§8.3 新增查询 API）', () => {
    it('结构化裸名称兼容：延吉 → 延吉市 / 延边朝鲜族自治州', () => {
      expect(resolveParentAdministrativeArea('延吉')).toEqual({
        input: '延吉',
        canonicalName: '延吉市',
        level: 'county_level_city',
        parentCity: '延边朝鲜族自治州',
      });
    });

    it('显式后缀名称：珲春市 → 延边朝鲜族自治州', () => {
      expect(resolveParentAdministrativeArea('珲春市')).toEqual({
        input: '珲春市',
        canonicalName: '珲春市',
        level: 'county_level_city',
        parentCity: '延边朝鲜族自治州',
      });
    });

    it('未收录县级市（含待 Phase 3 补录的余姚/慈溪）与未知城市不猜父级', () => {
      expect(resolveParentAdministrativeArea('余姚')).toBeNull();
      expect(resolveParentAdministrativeArea('慈溪市')).toBeNull();
      expect(resolveParentAdministrativeArea('火星')).toBeNull();
      expect(resolveParentAdministrativeArea('  ')).toBeNull();
    });
  });

  describe('行政区数据现状基线（方案 9.2 已知缺陷，迁移期不修正）', () => {
    it('golden：延吉市在全国显式表与县级市映射中双轨在册', () => {
      expect(NATIONAL_CITY_SUFFIX_TO_CITY['延吉市']).toBe('延吉');
      expect(COUNTY_LEVEL_CITY_TO_PREFECTURE['延吉市']).toBe('延边朝鲜族自治州');
    });

    it('golden：余姚双轨现状——显式表规范化为独立城市"余姚"，区县表映射宁波，县级市映射缺席', () => {
      // 方案 9.2：候选人说"余姚"能走宁波，说更标准的"余姚市"存在 city=余姚 直查
      // 海绵的路径隐患。Phase 3 将先用真实海绵查询验证存储口径后补录
      // COUNTY_LEVEL_CITY_TO_PREFECTURE（届时更新本用例），此前锁定现状。
      expect(NATIONAL_CITY_SUFFIX_TO_CITY['余姚市']).toBe('余姚');
      expect(NATIONAL_CITY_SUFFIX_TO_CITY['慈溪市']).toBe('慈溪');
      expect(DISTRICT_TO_CITY['余姚']).toBe('宁波');
      expect(COUNTY_LEVEL_CITY_TO_PREFECTURE['余姚市']).toBeUndefined();
      expect(COUNTY_LEVEL_CITY_TO_PREFECTURE['慈溪市']).toBeUndefined();
    });

    it(
      'golden：SUPPORTED_CITY_PREFIXES 现状混入省份"江西"——它实际是"高置信裸地名别名表"' +
        '而非纯城市表（9.5 将改名，改名前锁定现状语义）',
      () => {
        expect(SUPPORTED_CITY_PREFIXES).toContain('江西');
      },
    );

    it('15.3 不变量：区县/地标白名单不存在空 key，映射值非空', () => {
      for (const [key, value] of [
        ...Object.entries(DISTRICT_TO_CITY),
        ...Object.entries(LOCATION_TO_CITY),
        ...Object.entries(COUNTY_LEVEL_CITY_TO_PREFECTURE),
      ]) {
        expect(key.trim()).toBe(key);
        expect(key.length).toBeGreaterThan(0);
        expect(value.trim().length).toBeGreaterThan(0);
      }
    });
  });

  describe('detectGeoSignalConflict（Phase 3 冲突检测 shadow 档）', () => {
    it('多信号指向不同城市 → 记录候选清单与先命中城市（badcase xnp1u820 形态）', () => {
      const shadow = detectGeoSignalConflict(['静安区'], ['光谷']);
      expect(shadow).toEqual({
        candidates: [
          { city: '上海', evidence: 'unique_district_alias', matchedText: '静安区' },
          { city: '武汉', evidence: 'hotspot_alias', matchedText: '光谷' },
        ],
        firstHitCity: '上海',
      });
      // shadow 不改变现行行为：resolveCityFromGeoSignals 仍先命中先赢
      expect(resolveCityFromGeoSignals(['静安区'], ['光谷'])).toEqual({
        value: '上海',
        evidence: 'unique_district_alias',
      });
    });

    it('多信号指向同一城市 → 不构成冲突', () => {
      expect(detectGeoSignalConflict(['青浦区'], ['陆家嘴'])).toBeNull();
    });

    it('单信号 / 白名单外信号 / 空信号 → 不构成冲突', () => {
      expect(detectGeoSignalConflict(['静安区'], null)).toBeNull();
      expect(detectGeoSignalConflict(['鼓楼区'], ['万达广场'])).toBeNull();
      expect(detectGeoSignalConflict(null, null)).toBeNull();
    });
  });
});
