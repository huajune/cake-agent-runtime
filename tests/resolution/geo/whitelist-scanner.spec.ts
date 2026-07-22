import {
  DISTRICT_TO_CITY,
  matchInUncoveredSegments,
  scanWhitelistKeysByLongest,
} from '@resolution/geo';

describe('resolution/geo matching（Phase 0 golden cases 平移）', () => {
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
});
