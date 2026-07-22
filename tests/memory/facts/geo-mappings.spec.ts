import {
  COUNTY_LEVEL_CITY_TO_PREFECTURE,
  DISTRICT_TO_CITY,
  GENERIC_AMBIGUOUS_SUFFIXES,
  hasGenericAmbiguousSuffix,
  LOCATION_TO_CITY,
  matchInUncoveredSegments,
  NATIONAL_CITY_SUFFIX_TO_CITY,
  normalizeCityName,
  normalizeDistrictForLookup,
  SUPPORTED_CITY_PREFIXES,
  resolveCityFromDistrict,
  resolveCityFromGeoSignals,
  resolveCityFromLocation,
  scanWhitelistKeysByLongest,
} from '@memory/facts/geo-mappings';

describe('geo-mappings', () => {
  describe('normalizeDistrictForLookup', () => {
    it('keeps development zones and new districts intact', () => {
      expect(normalizeDistrictForLookup('亦庄开发区')).toBe('亦庄开发区');
      expect(normalizeDistrictForLookup('浦东新区')).toBe('浦东新区');
    });

    it('removes the street suffix but keeps the core name', () => {
      expect(normalizeDistrictForLookup('中南路街道')).toBe('中南路');
    });

    it('strips generic administrative suffixes for lookup fallback', () => {
      expect(normalizeDistrictForLookup('杨浦区')).toBe('杨浦');
      expect(normalizeDistrictForLookup('余姚市')).toBe('余姚市');
      expect(normalizeDistrictForLookup('崇阳县')).toBe('崇阳');
      expect(normalizeDistrictForLookup('白沙镇')).toBe('白沙');
      expect(normalizeDistrictForLookup('龙坪乡')).toBe('龙坪');
    });
  });

  describe('normalizeCityName', () => {
    it('trims whitespace and drops the city suffix', () => {
      expect(normalizeCityName(' 上海市 ')).toBe('上海');
      expect(normalizeCityName('南昌')).toBe('南昌');
    });

    it('returns null for emptyish values', () => {
      expect(normalizeCityName('   ')).toBeNull();
      expect(normalizeCityName(null)).toBeNull();
      expect(normalizeCityName(undefined)).toBeNull();
    });
  });

  describe('hasGenericAmbiguousSuffix', () => {
    it('完整等于黑名单条目时命中', () => {
      expect(hasGenericAmbiguousSuffix('万达广场')).toBe(true);
      expect(hasGenericAmbiguousSuffix('火车站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('人民广场')).toBe(true);
    });

    it('以黑名单条目结尾时命中（连锁商业体/公共设施）', () => {
      expect(hasGenericAmbiguousSuffix('合肥万达广场')).toBe(true);
      expect(hasGenericAmbiguousSuffix('龙湖天街')).toBe(true);
      expect(hasGenericAmbiguousSuffix('交通大学')).toBe(true);
    });

    it('交通站点带 ≥2 字专名前缀时不命中（badcase: 漕宝路地铁报站名被反问城市）', () => {
      expect(hasGenericAmbiguousSuffix('漕宝路地铁站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('上海火车站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('北京西站火车站')).toBe(false);
      expect(hasGenericAmbiguousSuffix('虹桥高铁站')).toBe(false);
    });

    it('交通站点前缀过短或本身仍是通名时照旧命中', () => {
      expect(hasGenericAmbiguousSuffix('南地铁站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('长途汽车站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('中心客运站')).toBe(true);
      expect(hasGenericAmbiguousSuffix('汽车客运站')).toBe(true);
    });

    it('前后有空白时仍能匹配（自动 trim）', () => {
      expect(hasGenericAmbiguousSuffix('  万达广场  ')).toBe(true);
    });

    it('唯一对应某城市的非黑名单地名不命中（让 LLM 通识可用）', () => {
      expect(hasGenericAmbiguousSuffix('马陆')).toBe(false);
      expect(hasGenericAmbiguousSuffix('陆家嘴')).toBe(false);
      expect(hasGenericAmbiguousSuffix('光谷')).toBe(false);
      expect(hasGenericAmbiguousSuffix('中关村')).toBe(false);
    });

    it('空字符串 / 空白 / 不在黑名单的普通地名不命中', () => {
      expect(hasGenericAmbiguousSuffix('')).toBe(false);
      expect(hasGenericAmbiguousSuffix('   ')).toBe(false);
      expect(hasGenericAmbiguousSuffix('人民路 123 号')).toBe(false);
    });

    it('黑名单常量本身的每一项都自命中', () => {
      for (const suffix of GENERIC_AMBIGUOUS_SUFFIXES) {
        expect(hasGenericAmbiguousSuffix(suffix)).toBe(true);
      }
    });
  });

  // ==================== Phase 0 行为基线（geo-domain-refactor-plan v3.1 §13） ====================
  // 以下 golden cases 一律按现状行为断言（含业务偏置与已知数据双轨现状），
  // 为 resolution/geo 迁移锁行为等价基线；行为修正只允许出现在后续阶段的显式提交里。

  describe('scanWhitelistKeysByLongest（最长优先 + 字符覆盖继承）', () => {
    it('golden：浦东新区航头镇 → "浦东新区"先被认领，不被"浦东"抢占', () => {
      const scan = scanWhitelistKeysByLongest('浦东新区航头镇', DISTRICT_TO_CITY);
      expect(scan.hits.map((hit) => hit.key)).toEqual(['浦东新区']);
      expect(scan.hits[0]).toEqual({ key: '浦东新区', start: 0, end: 4 });
    });

    it('covered 长度恒等于消息长度，且命中区间互不重叠（15.3 不变量）', () => {
      const message = '我在浦东新区航头镇附近找兼职';
      const scan = scanWhitelistKeysByLongest(message, DISTRICT_TO_CITY);
      expect(scan.covered).toHaveLength(message.length);
      const seen = new Array(message.length).fill(false);
      for (const hit of scan.hits) {
        for (let i = hit.start; i < hit.end; i++) {
          expect(seen[i]).toBe(false);
          seen[i] = true;
        }
      }
    });

    it('preCovered 继承：前轮已认领的字符段不会被后轮字典再消费', () => {
      const cityScan = scanWhitelistKeysByLongest('上海浦东', { 上海: '上海' });
      const districtScan = scanWhitelistKeysByLongest(
        '上海浦东',
        DISTRICT_TO_CITY,
        cityScan.covered,
      );
      expect(cityScan.hits.map((hit) => hit.key)).toEqual(['上海']);
      expect(districtScan.hits.map((hit) => hit.key)).toEqual(['浦东']);
    });
  });

  describe('matchInUncoveredSegments（未覆盖段正则兜底）', () => {
    it('只在白名单未认领的字符段上匹配 raw district', () => {
      const scan = scanWhitelistKeysByLongest('浦东新区航头镇', DISTRICT_TO_CITY);
      const raw = matchInUncoveredSegments(
        '浦东新区航头镇',
        scan.covered,
        /([一-龥]{2,8}(?:区|县|镇|街道))/,
      );
      expect(raw).toEqual(['航头镇']);
    });
  });

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

  describe('resolveCityFromLocation（唯一地标白名单）', () => {
    it('golden：陆家嘴 → 上海；光谷 → 武汉', () => {
      expect(resolveCityFromLocation('陆家嘴')).toBe('上海');
      expect(resolveCityFromLocation('光谷')).toBe('武汉');
    });

    it('通用商业体不入地标白名单（万达广场走歧义黑名单）', () => {
      expect(resolveCityFromLocation('万达广场')).toBeNull();
      expect(hasGenericAmbiguousSuffix('万达广场')).toBe(true);
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

    it('15.3 不变量：normalizeCityName 幂等，且不产生空白 key', () => {
      for (const value of ['上海市', ' 宁波 ', '延边朝鲜族自治州', '余姚市']) {
        const once = normalizeCityName(value);
        expect(once).toBeTruthy();
        expect(normalizeCityName(once)).toBe(once);
      }
    });

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
});
