import { buildNoMatchScript } from '@tools/duliday/job-list/no-match-script.util';

describe('buildNoMatchScript', () => {
  describe('querySummary', () => {
    it('brand + region + city combined with km', () => {
      const s = buildNoMatchScript({
        brandLabels: ['汉堡王'],
        cityLabels: ['上海'],
        regionLabels: ['徐汇'],
        maxKm: 1.5,
      });
      expect(s.querySummary).toBe('汉堡王（上海徐汇），附近 1.5km 内');
    });

    it('store-only query anchors on store', () => {
      const s = buildNoMatchScript({ storeLabels: ['人广店'], cityLabels: ['上海'] });
      expect(s.querySummary).toContain('人广店');
      expect(s.querySummary).toContain('上海');
    });

    it('falls back to 岗位 when no labels', () => {
      const s = buildNoMatchScript({});
      expect(s.querySummary).toBe('岗位');
    });

    it('emits schedule constraint when provided', () => {
      const s = buildNoMatchScript({
        brandLabels: ['肯德基'],
        scheduleConstraintLabel: '只周末',
      });
      expect(s.querySummary).toContain('限 只周末');
    });
  });

  describe('candidateMessage', () => {
    it('brand-anchored intro uses brand name', () => {
      const s = buildNoMatchScript({ brandLabels: ['汉堡王'], regionLabels: ['徐汇'] });
      expect(s.candidateMessage).toContain('汉堡王在徐汇这片');
      expect(s.candidateMessage).toContain('暂时没找到合适的岗位');
      expect(s.candidateMessage).toContain('餐饮兼职群');
    });

    it('store-anchored intro takes precedence over brand', () => {
      const s = buildNoMatchScript({
        brandLabels: ['汉堡王'],
        storeLabels: ['人广店'],
        regionLabels: ['徐汇'],
      });
      expect(s.candidateMessage).toContain('人广店这家');
      expect(s.candidateMessage).not.toContain('汉堡王在');
    });

    it('falls back to "咱们这边" when no brand/store', () => {
      const s = buildNoMatchScript({ cityLabels: ['上海'] });
      expect(s.candidateMessage).toContain('咱们这边');
    });

    it('always includes 拉群 follow-up action', () => {
      const s = buildNoMatchScript({});
      expect(s.candidateMessage).toContain('餐饮兼职群');
      expect(s.candidateMessage).toContain('@你');
    });
  });

  describe('structured fields', () => {
    it('nextToolCall is invite_to_group', () => {
      expect(buildNoMatchScript({}).nextToolCall).toBe('invite_to_group');
    });

    it('forbiddenActions lists cross-brand + 城市扩张 + 编造门店状态 + 静默拉群 禁止项', () => {
      const f = buildNoMatchScript({}).forbiddenActions;
      expect(f.some((x) => x.includes('换品牌'))).toBe(true);
      expect(f.some((x) => x.includes('跨品牌'))).toBe(true);
      expect(f.some((x) => x.includes('关了') || x.includes('搬了'))).toBe(true);
      expect(f.some((x) => x.includes('静默'))).toBe(true);
    });
  });
});
