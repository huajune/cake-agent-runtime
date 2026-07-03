import {
  classifyGeocodeQuery,
  hasContextualGenericPoiPrefix,
  hasEmbeddedCityHint,
  shouldTryStructuredGeocode,
} from '@infra/geocoding/geocoding-query-classifier.util';
import type { GeocodeQueryKind } from '@infra/geocoding/geocoding.types';

describe('geocoding query classifier', () => {
  const cases: Array<{
    address: string;
    expected: GeocodeQueryKind;
    note: string;
  }> = [
    // metro_station
    { address: '花木路地铁站', expected: 'metro_station', note: '带专名的地铁站' },
    { address: '漕宝路地铁', expected: 'metro_station', note: '口语省略“站”' },
    { address: '七莘路站', expected: 'metro_station', note: '站点后缀' },
    { address: '虹桥火车站', expected: 'metro_station', note: '铁路站点' },
    { address: '龙阳路站', expected: 'metro_station', note: '地铁/交通站点' },
    { address: '世纪公园站', expected: 'metro_station', note: '公园名 + 站' },

    // road
    { address: '花木路', expected: 'road', note: '普通道路名' },
    { address: '张杨路', expected: 'road', note: '上海道路名' },
    { address: '南京西路', expected: 'road', note: '方向词道路名' },
    { address: '金海公路', expected: 'road', note: '公路按道路处理' },
    { address: '长岛路', expected: 'road', note: '普通道路名' },
    { address: '瑞虹路', expected: 'road', note: '普通道路名' },
    { address: '沪南公路', expected: 'road', note: '公路型道路' },
    { address: '人民大道', expected: 'road', note: '大道后缀' },

    // admin_area
    { address: '浦东新区', expected: 'admin_area', note: '区级行政区' },
    { address: '闵行区', expected: 'admin_area', note: '区级行政区' },
    { address: '雨花区', expected: 'admin_area', note: '跨城同名区也先归类为行政区' },
    { address: '长沙县', expected: 'admin_area', note: '县级行政区' },
    { address: '九亭镇', expected: 'admin_area', note: '镇级行政区' },
    { address: '花木街道', expected: 'admin_area', note: '街道级行政区' },
    { address: '上海市', expected: 'admin_area', note: '城市行政区划' },
    { address: '江西省', expected: 'admin_area', note: '省级行政区划' },

    // generic_poi
    { address: '万达广场', expected: 'generic_poi', note: '跨城同名商业体' },
    { address: '万象城', expected: 'generic_poi', note: '跨城同名商业体' },
    { address: '吾悦广场', expected: 'generic_poi', note: '跨城同名商业体' },
    { address: '购物中心', expected: 'generic_poi', note: '通用商业类型词' },
    { address: '人民广场', expected: 'generic_poi', note: '跨城同名公共地标' },
    { address: '人民公园', expected: 'generic_poi', note: '跨城同名公共地标' },
    { address: '火车站', expected: 'generic_poi', note: '裸通名交通枢纽' },
    { address: '汽车站', expected: 'generic_poi', note: '裸通名交通枢纽' },
    { address: '长泰广场', expected: 'generic_poi', note: '广场后缀按现有通用歧义处理' },

    // specific_poi
    { address: '世纪公园', expected: 'specific_poi', note: '具体公园 POI' },
    { address: '板桥小区', expected: 'specific_poi', note: '小区 POI' },
    { address: '丁香国际商业中心', expected: 'specific_poi', note: '商业中心 POI' },
    { address: '瑞虹天地月亮湾', expected: 'specific_poi', note: '商圈/商业体别名' },
    { address: '金桥翡翠坊', expected: 'specific_poi', note: '商业体别名' },
    { address: '中海环宇荟大厦', expected: 'specific_poi', note: '大厦 POI' },

    // unknown
    { address: '花木', expected: 'unknown', note: '短词，需交给高德和 city 约束判断' },
    { address: '附近', expected: 'unknown', note: '不可直接地理编码的泛化词' },
    { address: '   ', expected: 'unknown', note: '空白输入' },
  ];

  it.each(cases)('classifies "$address" as $expected ($note)', ({ address, expected }) => {
    expect(classifyGeocodeQuery(address)).toBe(expected);
  });

  it('covers exactly 40 curated address cases', () => {
    expect(cases).toHaveLength(40);
  });

  it.each([
    ['花木路', 'road', true],
    ['浦东新区', 'admin_area', true],
    ['花木路地铁站', 'metro_station', true],
    ['万达广场', 'generic_poi', false],
    ['世纪公园', 'specific_poi', false],
    ['花木', 'unknown', false],
  ] as Array<[string, GeocodeQueryKind, boolean]>)(
    'structured geocode decision for %s (%s) with city',
    (address, kind, expected) => {
      expect(classifyGeocodeQuery(address)).toBe(kind);
      expect(shouldTryStructuredGeocode(kind, '上海')).toBe(expected);
    },
  );

  it('does not try structured geocode without a city, even for roads/admin areas/stations', () => {
    expect(shouldTryStructuredGeocode('road', null)).toBe(false);
    expect(shouldTryStructuredGeocode('admin_area', '')).toBe(false);
    expect(shouldTryStructuredGeocode('metro_station')).toBe(false);
  });

  it.each([
    ['南京六合', true],
    ['常州钟楼区', true],
    ['上海浦东新区航头镇', true],
    ['六合区', false],
    ['雨花区', false],
  ])('detects embedded city hints for "%s"', (address, expected) => {
    expect(hasEmbeddedCityHint(address)).toBe(expected);
  });

  it.each([
    ['宝山宝龙广场', true],
    ['浦口江北天街', true],
    ['雨花台吾悦广场', true],
    ['万达广场', false],
    ['购物中心', false],
  ])('detects contextual generic POI prefixes for "%s"', (address, expected) => {
    expect(hasContextualGenericPoiPrefix(address)).toBe(expected);
  });
});
