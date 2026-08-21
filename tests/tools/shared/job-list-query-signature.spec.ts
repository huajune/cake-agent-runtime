import {
  buildJobListQuerySignature,
  REPEAT_QUERY_NOTICE,
} from '@tools/shared/job-list-query-signature';

const baseInput = {
  cityNameList: ['上海'],
  regionNameList: ['黄浦区'],
  brandAliasList: [],
  brandIdList: [],
  projectNameList: [],
  projectIdList: [],
  storeNameList: [],
  jobCategoryList: [],
  jobIdList: [],
  salaryPeriodNameList: [],
};

describe('buildJobListQuerySignature', () => {
  it('相同实质过滤条件得到相同签名（badcase 6a5dc7c4ce406a6aee57bf6d 三轮同参）', () => {
    const a = buildJobListQuerySignature({ ...baseInput });
    const b = buildJobListQuerySignature({ ...baseInput });
    expect(a).toBe(b);
  });

  it('数组顺序与首尾空格不影响签名', () => {
    const a = buildJobListQuerySignature({
      ...baseInput,
      cityNameList: ['上海', '北京'],
      brandAliasList: ['肯德基', 'KFC '],
    });
    const b = buildJobListQuerySignature({
      ...baseInput,
      cityNameList: ['北京 ', '上海'],
      brandAliasList: [' KFC', '肯德基'],
    });
    expect(a).toBe(b);
  });

  it('区域/品牌等实质条件变化时签名不同', () => {
    const original = buildJobListQuerySignature({ ...baseInput });
    expect(buildJobListQuerySignature({ ...baseInput, regionNameList: [] })).not.toBe(original);
    expect(buildJobListQuerySignature({ ...baseInput, brandAliasList: ['可可牛'] })).not.toBe(
      original,
    );
    expect(buildJobListQuerySignature({ ...baseInput, searchJobName: '后厨' })).not.toBe(original);
  });

  it('同一品牌的正向查询与排除查询签名不同', () => {
    const enforce = buildJobListQuerySignature({
      ...baseInput,
      brandAliasList: ['肯德基'],
      brandFilterMode: 'enforce',
    });
    const exclude = buildJobListQuerySignature({
      ...baseInput,
      brandAliasList: ['肯德基'],
      brandFilterMode: 'exclude',
    });
    expect(enforce).not.toBe(exclude);
  });

  it('排除品牌名单独参与签名：排除≠不限品牌，换排除对象≠原地踏步', () => {
    const noBrand = buildJobListQuerySignature({ ...baseInput });
    // exclude 模式下品牌不进上游查询参数（brandAliasList 为空），靠 excludeBrandNames 区分
    const excludeKfc = buildJobListQuerySignature({
      ...baseInput,
      brandFilterMode: 'exclude',
      excludeBrandNames: ['肯德基'],
    });
    const excludeMcd = buildJobListQuerySignature({
      ...baseInput,
      brandFilterMode: 'exclude',
      excludeBrandNames: ['麦当劳'],
    });
    expect(excludeKfc).not.toBe(noBrand);
    expect(excludeKfc).not.toBe(excludeMcd);
  });

  it('坐标四舍五入到 3 位小数：微小抖动不改变签名，实质移动改变', () => {
    const a = buildJobListQuerySignature({
      ...baseInput,
      location: { longitude: 121.4737, latitude: 31.2304, range: 10000 },
    });
    const b = buildJobListQuerySignature({
      ...baseInput,
      location: { longitude: 121.47372, latitude: 31.23041, range: 10000 },
    });
    const c = buildJobListQuerySignature({
      ...baseInput,
      location: { longitude: 121.51, latitude: 31.2304, range: 10000 },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('班次约束与用工形式参与签名；空约束等价于未传', () => {
    const original = buildJobListQuerySignature({ ...baseInput });
    expect(buildJobListQuerySignature({ ...baseInput, candidateScheduleConstraint: {} })).toBe(
      original,
    );
    expect(
      buildJobListQuerySignature({
        ...baseInput,
        candidateScheduleConstraint: { onlyWeekends: false },
      }),
    ).toBe(original);
    expect(
      buildJobListQuerySignature({
        ...baseInput,
        candidateScheduleConstraint: { onlyWeekends: true },
      }),
    ).not.toBe(original);
    expect(buildJobListQuerySignature({ ...baseInput, candidateLaborForm: '暑假工' })).not.toBe(
      original,
    );
  });

  it('空 location 对象等价于未传', () => {
    expect(buildJobListQuerySignature({ ...baseInput, location: {} })).toBe(
      buildJobListQuerySignature({ ...baseInput }),
    );
  });

  it('重复查询提醒遵守两轮征询协议，真无岗不拉群，拉群后停止推荐', () => {
    expect(REPEAT_QUERY_NOTICE).toContain('重复查询提醒');
    expect(REPEAT_QUERY_NOTICE).toContain('扩大到全市');
    // 阶梯顺序：改查询 → 真无岗收口 → 两轮不满意后征询入群；不再混入转人工旧分支。
    const inviteIndex = REPEAT_QUERY_NOTICE.indexOf('invite_to_group');
    expect(inviteIndex).toBeGreaterThan(-1);
    expect(REPEAT_QUERY_NOTICE).toContain('真实无岗');
    expect(REPEAT_QUERY_NOTICE).toContain('不调用 invite_to_group');
    expect(REPEAT_QUERY_NOTICE).toContain('连续两轮否定具体推荐');
    expect(REPEAT_QUERY_NOTICE).toContain('下一轮明确同意后才调用 invite_to_group');
    expect(REPEAT_QUERY_NOTICE).toContain('已经成功拉群时，禁止继续查询、推荐');
    expect(REPEAT_QUERY_NOTICE).not.toContain('request_handoff');
    expect(REPEAT_QUERY_NOTICE).toContain('严禁声称已扩大范围却原样重查');
  });
});
