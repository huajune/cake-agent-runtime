import {
  candidateDistrictMatchesAddress,
  confidenceForPrecision,
  extractDistrictStems,
  groupCandidatesByCity,
  inferPoiPrecision,
  inferStructuredPrecision,
  mergeAndRankCandidates,
  pickAnchorCandidate,
} from '@infra/geocoding/geocoding-candidate-ranker.util';
import type { GeocodeCandidate } from '@infra/geocoding/geocoding.types';

/**
 * Phase 0 行为基线（geo-domain-refactor-plan v3.1 §13）：
 * geocoding-candidate-ranker 此前无 spec，本文件按现状行为断言，为迁移锁基线。
 *
 * 工作流 B-3（方案 11.5，badcase 0m4zs1h6 / chat 6a4dcef8ce406a6aeec56fd8）排查结论：
 * 该 case 发给候选人的错误定位坐标 (121.511937, 31.239212) 来自海绵门店数据
 * storeInfo.latitude/longitude 直传（send_store_location 的 store 目的地分支不经过
 * 本 ranker），与上海中心大厦真实位置（约 121.5057, 31.2337）偏差约 800m——
 * 根因是门店坐标数据质量，不是候选排序选点。ranker 侧以下用例锁定"道路代表点
 * 不得压过站点/POI"的选点契约不回归；门店坐标直传的现状基线见
 * send-store-location.tool.spec.ts。
 */

function makeCandidate(overrides: Partial<GeocodeCandidate> = {}): GeocodeCandidate {
  return {
    formattedAddress: '上海市嘉定区马陆镇',
    province: '上海市',
    city: '上海市',
    district: '嘉定区',
    township: '马陆镇',
    longitude: 121.27,
    latitude: 31.32,
    poiName: '马陆镇',
    typecode: '',
    source: 'poi',
    precision: 'poi',
    confidence: 'high',
    ...overrides,
  };
}

describe('geocoding-candidate-ranker.util', () => {
  describe('inferPoiPrecision', () => {
    it('1505* typecode 或名称以"站"结尾 → metro_station', () => {
      expect(inferPoiPrecision('七莘路(地铁站)', '150500')).toBe('metro_station');
      expect(inferPoiPrecision('漕宝路地铁站', '')).toBe('metro_station');
      expect(inferPoiPrecision('虹桥火车站', null)).toBe('metro_station');
    });

    it('1903* typecode（交通地名/道路）→ road', () => {
      expect(inferPoiPrecision('七莘路', '190301')).toBe('road');
    });

    it('其余（含缺 typecode 的旧缓存候选）→ poi', () => {
      expect(inferPoiPrecision('陆家嘴中心', '060101')).toBe('poi');
      expect(inferPoiPrecision('九亭镇', null)).toBe('poi');
      expect(inferPoiPrecision(null, undefined)).toBe('poi');
    });
  });

  describe('inferStructuredPrecision', () => {
    it('高德结构化 level → 精度枚举映射', () => {
      expect(inferStructuredPrecision('公交地铁站点')).toBe('metro_station');
      expect(inferStructuredPrecision('兴趣点')).toBe('poi');
      expect(inferStructuredPrecision('道路')).toBe('road');
      expect(inferStructuredPrecision('乡镇')).toBe('township');
      expect(inferStructuredPrecision('街道')).toBe('township');
      expect(inferStructuredPrecision('区县')).toBe('district');
      expect(inferStructuredPrecision('城市')).toBe('city');
      expect(inferStructuredPrecision('热点商圈')).toBe('unknown');
      expect(inferStructuredPrecision(null)).toBe('unknown');
    });
  });

  describe('confidenceForPrecision', () => {
    it('站点/POI 高可信，道路/乡镇/区县中等，其余低', () => {
      expect(confidenceForPrecision('metro_station')).toBe('high');
      expect(confidenceForPrecision('poi')).toBe('high');
      expect(confidenceForPrecision('road')).toBe('medium');
      expect(confidenceForPrecision('township')).toBe('medium');
      expect(confidenceForPrecision('district')).toBe('medium');
      expect(confidenceForPrecision('city')).toBe('low');
      expect(confidenceForPrecision('unknown')).toBe('low');
    });
  });

  describe('mergeAndRankCandidates', () => {
    it('按 城市+区+地址+坐标 去重', () => {
      const a = makeCandidate();
      const b = makeCandidate();
      expect(mergeAndRankCandidates([a, b])).toHaveLength(1);
    });

    it('精度排序：地铁站 > POI > 乡镇 > 区县 > 道路 > 城市', () => {
      const road = makeCandidate({
        poiName: '某路',
        typecode: '190301',
        formattedAddress: 'addr-road',
      });
      const metro = makeCandidate({
        poiName: '某站',
        typecode: '150500',
        formattedAddress: 'addr-metro',
      });
      const poi = makeCandidate({
        poiName: '某商场店',
        typecode: '060101',
        formattedAddress: 'addr-poi',
      });
      const district = makeCandidate({
        poiName: '',
        source: 'structured',
        precision: 'district',
        formattedAddress: 'addr-district',
      });

      const ranked = mergeAndRankCandidates([road, district, poi, metro]);
      expect(ranked.map((c) => c.formattedAddress)).toEqual([
        'addr-metro',
        'addr-poi',
        'addr-district',
        'addr-road',
      ]);
    });

    it('同精度时 POI 来源优先于结构化来源', () => {
      const structuredPoi = makeCandidate({
        source: 'structured',
        precision: 'poi',
        formattedAddress: 'addr-structured',
      });
      const poiSource = makeCandidate({
        source: 'poi',
        typecode: '060101',
        formattedAddress: 'addr-poi-source',
      });

      const ranked = mergeAndRankCandidates([structuredPoi, poiSource]);
      expect(ranked[0].formattedAddress).toBe('addr-poi-source');
    });
  });

  describe('pickAnchorCandidate', () => {
    it('道路代表点排首位 + 同城存在地铁站 → 选地铁站（badcase 七莘路锚偏 ~10km）', () => {
      const road = makeCandidate({
        poiName: '七莘路',
        typecode: '190301',
        district: '闵行区',
        longitude: 121.327282,
        latitude: 31.192294,
      });
      const metro = makeCandidate({
        poiName: '七莘路(地铁站)',
        typecode: '150500',
        district: '闵行区',
        longitude: 121.355,
        latitude: 31.108,
      });

      const anchor = pickAnchorCandidate([road, metro]);
      expect(anchor.longitude).toBe(121.355);
      expect(anchor.latitude).toBe(31.108);
    });

    it('全部道路候选 → 兜底取排序后的首条', () => {
      const first = makeCandidate({
        poiName: '某路',
        typecode: '190301',
        formattedAddress: 'road-1',
      });
      const second = makeCandidate({
        poiName: '某路辅路',
        typecode: '190301',
        formattedAddress: 'road-2',
      });
      expect(pickAnchorCandidate([first, second]).formattedAddress).toBe('road-1');
    });
  });

  describe('extractDistrictStems / candidateDistrictMatchesAddress', () => {
    it('抽出"X区/X县"级 token 并归一化（雨花区→雨花、长沙县→长沙）', () => {
      expect(extractDistrictStems('雨花区板桥')).toEqual(['雨花']);
      expect(extractDistrictStems('长沙县板桥')).toEqual(['长沙']);
      expect(extractDistrictStems('浦东新区航头镇')).toEqual(['浦东新区']);
      expect(extractDistrictStems('板桥小学')).toEqual([]);
    });

    it('候选区名与用户报的区 stem 双向包含即视为一致', () => {
      expect(candidateDistrictMatchesAddress(['雨花'], '雨花台区')).toBe(true);
      expect(candidateDistrictMatchesAddress(['雨花'], '长沙县')).toBe(false);
    });

    it('高德没回区名时按一致放行，避免误拦', () => {
      expect(candidateDistrictMatchesAddress(['雨花'], '')).toBe(true);
      expect(candidateDistrictMatchesAddress(['雨花'], '  ')).toBe(true);
    });
  });

  describe('groupCandidatesByCity', () => {
    it('按城市去重，同城取排序最优候选', () => {
      const shRoad = makeCandidate({
        city: '上海市',
        poiName: '解放路',
        typecode: '190301',
        formattedAddress: 'sh-road',
      });
      const shMetro = makeCandidate({
        city: '上海市',
        poiName: '解放路(地铁站)',
        typecode: '150500',
        formattedAddress: 'sh-metro',
      });
      const nj = makeCandidate({
        city: '南京市',
        poiName: '解放路',
        typecode: '190301',
        formattedAddress: 'nj-road',
      });

      const grouped = groupCandidatesByCity([shRoad, shMetro, nj]);
      expect(grouped.size).toBe(2);
      expect(grouped.get('上海市')?.formattedAddress).toBe('sh-metro');
      expect(grouped.get('南京市')?.formattedAddress).toBe('nj-road');
    });
  });
});
