import {
  buildDistancePrecisionNotice,
  formatDistanceKm,
  type DistanceAnchorPrecision,
} from '@tools/duliday/job-list/distance-render.util';

describe('distance-render.util（方案 11.3 区级锚点估算口径）', () => {
  const areaAnchor: DistanceAnchorPrecision = { precision: 'area_level', areaName: '海淀区' };
  const poiAnchor: DistanceAnchorPrecision = { precision: 'poi', areaName: null };

  describe('formatDistanceKm', () => {
    it('poi 锚点 → 精确口径 "3.2km"', () => {
      expect(formatDistanceKm(3.21, poiAnchor)).toBe('3.2km');
    });

    it('无锚点信息 → 精确口径（向后兼容）', () => {
      expect(formatDistanceKm(3.21)).toBe('3.2km');
      expect(formatDistanceKm(3.21, null)).toBe('3.2km');
    });

    it('区级锚点 → "约X.Xkm（按XX估算）"', () => {
      expect(formatDistanceKm(3.21, areaAnchor)).toBe('约3.2km（按海淀区估算）');
    });

    it('区级锚点但缺行政区名 → 用"区域中心"兜底文案', () => {
      expect(formatDistanceKm(1.0, { precision: 'area_level', areaName: null })).toBe(
        '约1.0km（按区域中心估算）',
      );
      expect(formatDistanceKm(1.0, { precision: 'area_level', areaName: '  ' })).toBe(
        '约1.0km（按区域中心估算）',
      );
    });
  });

  describe('buildDistancePrecisionNotice', () => {
    it('区级锚点 → 头部声明含行政区名与估算/禁令口径', () => {
      const notice = buildDistancePrecisionNotice(areaAnchor);
      expect(notice).toContain('定位精度：区级代表点（海淀区）');
      expect(notice).toContain('估算值');
      expect(notice).toContain('严禁');
    });

    it('poi 锚点 / 无锚点 → 不渲染声明', () => {
      expect(buildDistancePrecisionNotice(poiAnchor)).toBeNull();
      expect(buildDistancePrecisionNotice(null)).toBeNull();
      expect(buildDistancePrecisionNotice(undefined)).toBeNull();
    });
  });
});
