import {
  detectGeoSignalConflict,
  isKnownCanonicalAdministrativeAreaName,
  isRecognizedCityName,
  resolveCityFromDistrict,
  resolveCityFromGeoSignals,
  resolveParentAdministrativeArea,
  resolveProvinceFromAdministrativeArea,
} from '@resolution/geo';
// 数据表不是公共 API（Phase 5 过渡期导出已收口）；域内测试断言数据现状时直连数据模块。
import {
  COUNTY_LEVEL_CITY_TO_PREFECTURE,
  UNIQUE_SUBDIVISION_TO_CITY,
  HIGH_CONFIDENCE_BARE_LOCATION_ALIASES,
} from '@resolution/geo/administrative-division.data';
import { NATIONAL_CITY_SUFFIX_TO_CITY } from '@resolution/geo/explicit-city.data';
import { UNIQUE_PLACE_ALIAS_TO_CITY } from '@resolution/geo/place-alias.data';

describe('resolution/geo admin（Phase 0 golden cases 平移 + §8.3 resolver）', () => {
  describe('resolveProvinceFromAdministrativeArea（结构化市→省）', () => {
    it('兼容市后缀省略与省市连写，不把省名「海南」错当自治州', () => {
      expect(resolveProvinceFromAdministrativeArea('泰州')).toBe('江苏省');
      expect(resolveProvinceFromAdministrativeArea('江苏泰州')).toBe('江苏省');
      expect(resolveProvinceFromAdministrativeArea('吉林市')).toBe('吉林省');
      expect(resolveProvinceFromAdministrativeArea('海南藏族自治州')).toBe('青海省');
      expect(resolveProvinceFromAdministrativeArea('海南')).toBeNull();
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

    it('崂山区 → 青岛（badcase recvqhLOPwv0m9，2026-07-24 业务足迹补录）', () => {
      expect(resolveCityFromDistrict('崂山区')).toBe('青岛');
      expect(resolveCityFromDistrict('崂山')).toBe('青岛');
      expect(resolveCityFromDistrict('市南区')).toBe('青岛');
      // 裸"市南/平度"不收（撞"超市南边"/"水平度"），保持保守
      expect(resolveCityFromDistrict('市南')).toBeNull();
      expect(resolveCityFromDistrict('平度市')).toBe('青岛');
    });

    it('golden：延吉市 → 延边朝鲜族自治州（县级市映射并入区县表）', () => {
      expect(resolveCityFromDistrict('延吉市')).toBe('延边朝鲜族自治州');
    });

    it('昆山市 → 苏州市（Phase 3 业务足迹补录，2026-07-22 真实海绵查询实证）', () => {
      expect(resolveCityFromDistrict('昆山市')).toBe('苏州市');
      expect(resolveParentAdministrativeArea('昆山')).toEqual({
        input: '昆山',
        canonicalName: '昆山市',
        level: 'county_level_city',
        parentCity: '苏州市',
      });
      expect(resolveParentAdministrativeArea('昆山市')?.parentCity).toBe('苏州市');
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

  describe('isKnownCanonicalAdministrativeAreaName（结构化字段成员判定）', () => {
    it.each(['上海', '巴音郭楞蒙古自治州', '克孜勒苏柯尔克孜自治州'])(
      '接受仓库行政区数据中的 canonical 名称 %s',
      (name) => {
        expect(isKnownCanonicalAdministrativeAreaName(name)).toBe(true);
      },
    );

    it.each(['杜撰测试蒙古自治州', '我想去巴音郭楞蒙古自治州'])(
      '拒绝仅有行政后缀或带句式前缀的伪 canonical 值 %s',
      (name) => {
        expect(isKnownCanonicalAdministrativeAreaName(name)).toBe(false);
      },
    );
  });

  describe('district-city-map 收编条目（2026-07-28 统一到 UNIQUE_SUBDIVISION_TO_CITY）', () => {
    it('黄埔→广州、宝安→深圳（黄埔案：区名报出后查询路径应默认所属城市）', () => {
      expect(resolveCityFromDistrict('黄埔')).toBe('广州');
      expect(resolveCityFromDistrict('黄埔区')).toBe('广州');
      expect(resolveCityFromDistrict('宝安')).toBe('深圳');
      // 上海黄浦（浦字不同）不受影响
      expect(resolveCityFromDistrict('黄浦')).toBe('上海');
    });

    it('原私表条目并入后生效：川沙→上海、南开区→天津、渝中→重庆', () => {
      expect(resolveCityFromDistrict('川沙')).toBe('上海');
      expect(resolveCityFromDistrict('南开区')).toBe('天津');
      expect(resolveCityFromDistrict('渝中')).toBe('重庆');
    });

    it('带后缀收录口径：裸"红桥/南开/静海"不推导（北京红桥市场、南开大学/中学误命中防线）', () => {
      expect(resolveCityFromDistrict('红桥')).toBeNull();
      expect(resolveCityFromDistrict('静海')).toBeNull();
      // 裸南开：normalizeDistrictForLookup 不会补"区"，命中不了带后缀 key
      expect(UNIQUE_SUBDIVISION_TO_CITY['南开']).toBeUndefined();
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
      expect(UNIQUE_SUBDIVISION_TO_CITY['余姚']).toBe('宁波');
      expect(COUNTY_LEVEL_CITY_TO_PREFECTURE['余姚市']).toBeUndefined();
      expect(COUNTY_LEVEL_CITY_TO_PREFECTURE['慈溪市']).toBeUndefined();
    });

    it(
      'golden：HIGH_CONFIDENCE_BARE_LOCATION_ALIASES 现状混入省份"江西"——它实际是"高置信裸地名别名表"' +
        '而非纯城市表（9.5 将改名，改名前锁定现状语义）',
      () => {
        expect(HIGH_CONFIDENCE_BARE_LOCATION_ALIASES).toContain('江西');
      },
    );

    it('15.3 不变量：区县/地标白名单不存在空 key，映射值非空', () => {
      for (const [key, value] of [
        ...Object.entries(UNIQUE_SUBDIVISION_TO_CITY),
        ...Object.entries(UNIQUE_PLACE_ALIAS_TO_CITY),
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

    it('已确立会话城市命中候选 → 打 adjudicatedByKnownCity（非真冲突，enforce 不得拦）', () => {
      const shadow = detectGeoSignalConflict(['静安区'], ['光谷'], { knownCity: '武汉' });
      expect(shadow?.adjudicatedByKnownCity).toBe('武汉');
      // 候选清单与先命中城市保持原样，便于对账"裁决前本来是什么"
      expect(shadow?.firstHitCity).toBe('上海');
      expect(shadow?.candidates).toHaveLength(2);
    });

    it('已确立城市带"市"后缀也能裁决（归一化后比对）', () => {
      expect(
        detectGeoSignalConflict(['静安区'], ['光谷'], { knownCity: '上海市' })
          ?.adjudicatedByKnownCity,
      ).toBe('上海');
    });

    it('已确立城市不在候选内 / 未传 → 仍是真冲突，不打裁决标记', () => {
      expect(
        detectGeoSignalConflict(['静安区'], ['光谷'], { knownCity: '广州' }),
      ).not.toHaveProperty('adjudicatedByKnownCity');
      expect(detectGeoSignalConflict(['静安区'], ['光谷'], { knownCity: null })).not.toHaveProperty(
        'adjudicatedByKnownCity',
      );
      expect(detectGeoSignalConflict(['静安区'], ['光谷'])).not.toHaveProperty(
        'adjudicatedByKnownCity',
      );
    });
  });

  describe('脏别名排除（DIRTY_ALIAS_EXCLUSIONS，2026-07-29 生产实证）', () => {
    it('长阳：跨层级同形已移出白名单，不再解析出城市', () => {
      expect(resolveCityFromDistrict('长阳')).toBeNull();
      expect(resolveCityFromDistrict('长阳镇')).toBeNull();
    });

    it('长阳退出后，「北京市房山区长阳镇」形态不再产生跨城冲突（mpr 225908 回归）', () => {
      // 该样本正是 enforce 决策判 no-go 的唯一依据：房山→北京、长阳→宜昌 两候选
      expect(detectGeoSignalConflict(['房山', '长阳'], null)).toBeNull();
      expect(resolveCityFromGeoSignals(['房山', '长阳'], null)).toEqual({
        value: '北京',
        evidence: 'unique_district_alias',
      });
    });

    it('公安：泛词已移出，「公安局」类表述不再误判成荆州', () => {
      expect(resolveCityFromDistrict('公安')).toBeNull();
      expect(resolveCityFromDistrict('公安县')).toBeNull();
    });

    it('同批未被移出的宜昌/荆州区名仍正常解析（确认移出范围最小）', () => {
      expect(resolveCityFromDistrict('五峰')).toBe('宜昌');
      expect(resolveCityFromDistrict('秭归')).toBe('宜昌');
      expect(resolveCityFromDistrict('监利')).toBe('荆州');
    });
  });
  describe('isRecognizedCityName（结构化字段城市值认领）', () => {
    it.each(['上海', '上海市', '东莞', '呼和浩特', '昆山', '延吉', '东方'])(
      '认领真实城市/县级市 %s',
      (city) => {
        expect(isRecognizedCityName(city)).toBe(true);
      },
    );

    it('认领民族自治地方的去族名简称（巴音郭楞 ↔ 巴音郭楞蒙古自治州）', () => {
      expect(isRecognizedCityName('巴音郭楞')).toBe(true);
      expect(isRecognizedCityName('巴音郭楞蒙古自治州')).toBe(true);
      expect(isRecognizedCityName('克孜勒苏')).toBe(true);
    });

    // 2026-08-06 生产观测的 pref.city 污染实样：短串靠形状分辨不出真假，只能查表。
    it.each(['hello', 'null', '只晚班', '我是应聘的', '平坊', '00:30', '我是BOSS联系你的'])(
      '拒绝抽取污染残留 %s',
      (value) => {
        expect(isRecognizedCityName(value)).toBe(false);
      },
    );

    it('拒绝区名——"是不是城市"而非"是不是地名"', () => {
      expect(isRecognizedCityName('浦东新区')).toBe(false);
      expect(isRecognizedCityName('朝阳区')).toBe(false);
    });

    it('拒绝残缺前缀——前缀索引只对民族自治地方开放，地级市必须精确命中', () => {
      expect(isRecognizedCityName('呼和')).toBe(false);
      expect(isRecognizedCityName('石家')).toBe(false);
    });

    it.each([null, undefined, '', '  ', '沪'])('拒绝空值/单字 %s', (value) => {
      expect(isRecognizedCityName(value)).toBe(false);
    });
  });
});
