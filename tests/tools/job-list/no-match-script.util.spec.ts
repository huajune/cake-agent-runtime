import {
  buildNoMatchScript,
  buildPostInviteClosureScript,
} from '@tools/job-list/no-match-script.util';

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
      expect(s.candidateMessage).toContain('第一时间联系你');
      expect(s.candidateMessage).not.toContain('兼职群');
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

    it('true no-match waits for inventory instead of offering a group', () => {
      const s = buildNoMatchScript({});
      expect(s.candidateMessage).toContain('新岗位');
      expect(s.candidateMessage).not.toContain('兼职群');
      expect(s.nextAction).toBe('wait_for_inventory');
    });
  });

  describe('structured fields', () => {
    it('nextAction is a closed wait state', () => {
      expect(buildNoMatchScript({}).nextAction).toBe('wait_for_inventory');
    });

    it('forbiddenActions lists cross-brand + 城市扩张 + 编造门店状态 + 真无岗不拉群 禁止项', () => {
      const f = buildNoMatchScript({}).forbiddenActions;
      expect(f.some((x) => x.includes('换品牌'))).toBe(true);
      expect(f.some((x) => x.includes('跨品牌'))).toBe(true);
      expect(f.some((x) => x.includes('关了') || x.includes('搬了'))).toBe(true);
      expect(f.some((x) => x.includes('不得调用 invite_to_group'))).toBe(true);
    });

    it('adds a whole-city overclaim ban only for radius-capped queries', () => {
      const capped = buildNoMatchScript({ maxKm: 10 }).forbiddenActions;
      expect(capped.some((x) => x.includes('整个城市'))).toBe(true);
      const uncapped = buildNoMatchScript({ cityLabels: ['北京'] }).forbiddenActions;
      expect(uncapped.some((x) => x.includes('整个城市'))).toBe(false);
    });
  });

  describe('拉群后收口', () => {
    it('closes recommendation wording after a successful prior invite', () => {
      const script = buildPostInviteClosureScript({ groupName: '上海兼职群', city: '上海' });
      expect(script.nextAction).toBe('group_handoff_complete');
      expect(script.candidateMessage).toContain('上海兼职群');
      expect(script.forbiddenActions.join('\n')).toContain('禁止继续调用 duliday_job_list');
      expect(script.forbiddenActions.join('\n')).toContain('其他区域');
    });
  });
});

describe('班次过滤致空的如实披露（badcase 1rl3z9ai）', () => {
  it('有在招岗位被班次约束剔除时，话术说"有 N 家但排班对不上"而非"没找到岗位"', () => {
    const script = buildNoMatchScript({
      cityLabels: ['上海'],
      maxKm: 10,
      scheduleConstraintLabel: '只晚班',
      scheduleExcludedCount: 8,
    });
    expect(script.candidateMessage).toContain('有 8 家在招');
    expect(script.candidateMessage).toContain('只晚班');
    expect(script.candidateMessage).not.toContain('暂时没找到合适的岗位');
    expect(script.forbiddenActions.join('\n')).toContain('不得说成"附近没有岗位');
  });

  it('真无岗（零剔除）保持原话术', () => {
    const script = buildNoMatchScript({ cityLabels: ['上海'], maxKm: 10 });
    expect(script.candidateMessage).toContain('暂时没找到合适的岗位');
  });
});
