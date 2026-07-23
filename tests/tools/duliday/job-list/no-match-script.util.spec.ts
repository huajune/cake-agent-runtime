import {
  buildNoMatchScript,
  hasPriorNoMatchReply,
} from '@tools/duliday/job-list/no-match-script.util';

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

    // badcase 4c94j4f7：10km 圆内 0 结果被口播成"必胜客在北京这边没岗"，
    // 15 分钟后换锚点就查出 8.7km 的门店。半径查询不得升格成全城断言。
    it('distance-anchored query states the radius instead of claiming the whole city', () => {
      const s = buildNoMatchScript({
        brandLabels: ['必胜客'],
        cityLabels: ['北京'],
        maxKm: 10,
      });
      expect(s.candidateMessage).toContain('必胜客在你附近 10 公里内');
      expect(s.candidateMessage).not.toContain('北京这边');
    });

    it('keeps the region when combined with a radius', () => {
      const s = buildNoMatchScript({
        brandLabels: ['汉堡王'],
        regionLabels: ['徐汇'],
        maxKm: 5,
      });
      expect(s.candidateMessage).toContain('徐汇一带附近 5 公里内');
      expect(s.candidateMessage).not.toContain('徐汇这片');
    });

    it('keeps city phrasing when the query had no radius cap', () => {
      const s = buildNoMatchScript({ brandLabels: ['必胜客'], cityLabels: ['北京'] });
      expect(s.candidateMessage).toContain('必胜客在北京这边');
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

    it('adds a whole-city overclaim ban only for radius-capped queries', () => {
      const capped = buildNoMatchScript({ maxKm: 10 }).forbiddenActions;
      expect(capped.some((x) => x.includes('整个城市'))).toBe(true);
      const uncapped = buildNoMatchScript({ cityLabels: ['北京'] }).forbiddenActions;
      expect(uncapped.some((x) => x.includes('整个城市'))).toBe(false);
    });
  });

  describe('二次无岗升级（badcase 6a5df7e7 Aron 复读辱骂案）', () => {
    it('second-stage candidateMessage differs from first-stage and drops the group line', () => {
      const first = buildNoMatchScript({ brandLabels: ['必胜客'], cityLabels: ['沈阳'] });
      const second = buildNoMatchScript({
        brandLabels: ['必胜客'],
        cityLabels: ['沈阳'],
        priorNoMatchReplySent: true,
      });
      expect(second.candidateMessage).not.toBe(first.candidateMessage);
      expect(second.candidateMessage).toContain('记下来');
      expect(second.candidateMessage).toContain('第一时间联系你');
    });

    it('second-stage adds a no-verbatim-repeat forbidden action', () => {
      const second = buildNoMatchScript({ priorNoMatchReplySent: true });
      expect(second.forbiddenActions.some((x) => x.includes('逐字重复'))).toBe(true);
      const first = buildNoMatchScript({});
      expect(first.forbiddenActions.some((x) => x.includes('逐字重复'))).toBe(false);
    });
  });

  describe('hasPriorNoMatchReply', () => {
    it('detects prior no-match assistant reply (Aron 案原文形态)', () => {
      expect(
        hasPriorNoMatchReply([
          { role: 'user', content: '沈阳和平长白这里' },
          { role: 'assistant', content: '沈阳这边暂时没有合适的岗位，后续有匹配我会主动联系你' },
        ]),
      ).toBe(true);
      expect(
        hasPriorNoMatchReply([
          { role: 'assistant', content: '必胜客在你附近 10 公里内暂时没找到合适的岗位，我先帮你进餐饮兼职群' },
        ]),
      ).toBe(true);
    });

    it('ignores user messages and unrelated assistant texts', () => {
      expect(
        hasPriorNoMatchReply([
          { role: 'user', content: '暂时没有合适的岗位吗' },
          { role: 'assistant', content: '帮你查到 3 个岗位，看看哪个合适' },
        ]),
      ).toBe(false);
    });
  });
});
