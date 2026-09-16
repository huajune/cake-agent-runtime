import {
  detectJobFactWithoutProvenance,
  detectJobQueryClaimWithoutQuery,
  formatJobFactProvenanceTexts,
} from '@agent/guardrail/output/rules/job-fact-reconciliation.rule';
import type { RecommendedJobSummary } from '@resolution/job/types';

const jobListCall = { toolName: 'duliday_job_list', args: {}, result: { resultCount: 1 } } as never;

describe('job_query_claim_without_query（零工具轮宣称查过）', () => {
  it.each([
    '帮你查了下，附近还有这两家',
    '目前系统里暂时没查到香樟苑附近具体的门店岗位信息',
    '我看了下，这边暂时没有合适的岗位',
    '暂时没查到附近的兼职岗位',
  ])('零查岗工具 + 完成时态宣称 → repair：%s', (reply) => {
    expect(detectJobQueryClaimWithoutQuery(reply, [])?.action).toBe('replan');
  });

  it.each(['帮你查了下，附近还有这两家', '系统里没查到'])('本轮有查岗工具即放行：%s', (reply) => {
    expect(detectJobQueryClaimWithoutQuery(reply, [jobListCall])).toBeNull();
  });

  it.each([
    '刚才帮你查了下就这两家，你看哪家方便',
    '之前查到的那家肯德基还在招',
    '你发个定位我帮你查下附近的岗位',
    '我再帮你看看其他合适的',
    '我看了下你的健康证，日期还在有效期内',
    '我看了下你发的定位，离门店不远',
  ])('回指历史、将来时与非查岗的"看了下"不判：%s', (reply) => {
    expect(detectJobQueryClaimWithoutQuery(reply, [])).toBeNull();
  });
});

describe('job_fact_without_provenance（零工具轮的无来源岗位数字）', () => {
  const history = [
    '肯德基（万荣路市北高新店），2.7km\n薪资：基础17元/时',
    '面试时间是 13:30-16:30',
  ];

  it('历史从未出现的薪资/距离 → repair（badcase kwxk74gn）', () => {
    const hit = detectJobFactWithoutProvenance(
      '普陀这边全职岗不多，长风大悦城有家 M Stand 全职店员，薪资 22-28 元/时。',
      [],
      history,
    );
    expect(hit?.action).toBe('replan');
    expect(hit?.label).toContain('22-28 元/时');
  });

  it('复述历史里说过的数字放行（跨轮合法提醒）', () => {
    expect(
      detectJobFactWithoutProvenance('肯德基那家 2.7km，基础 17 元/时，你考虑下', [], history),
    ).toBeNull();
    expect(
      detectJobFactWithoutProvenance('面试时间是 13:30～16:30，明天来得及', [], history),
    ).toBeNull();
  });

  it('上一轮工具结果沉淀进会话记忆的班次被挑出来回答追问，不算无来源（trace …_1789537953238）', () => {
    // 上一轮助手只口头说了"早中夜三班轮换 / 10:00-22:00可选"，具体时段只存在于记忆的岗位摘要里。
    const priorReplies = [
      '奥乐齐（庆春银泰）- 通岗店员，4.9km\n班次：早中夜三班轮换，5000-7000元/月\n\n' +
        '果蔬好（大悦城店）- 理货员/收银员，9.4km\n班次：10:00-22:00可选，4000-5000元/月',
    ];
    const reply =
      '有的～\n\n奥乐齐有早班 05:00-14:00，不过这家需要早中夜三班都能上。\n\n' +
      '果蔬好有 10:00-19:00 的上午班，可以只选这个班次。';
    expect(detectJobFactWithoutProvenance(reply, [], priorReplies)?.action).toBe('replan');

    const memoryJobs: RecommendedJobSummary[] = [
      {
        jobId: 529402,
        brandName: '奥乐齐',
        jobName: '通岗店员',
        storeName: '庆春银泰',
        cityName: '杭州市',
        regionName: '上城区',
        laborForm: '全职',
        salaryDesc: '5000-7000 元/月',
        shiftSummary:
          '组合班次，全部需出勤：\n- 05:00-14:00（早班，全天班，约 9 小时）\n- 14:00-23:00（下午班）',
        jobCategoryName: '零售/超市/通岗店员',
        distanceKm: 4.9,
      },
      {
        jobId: 529138,
        brandName: '果蔬好',
        jobName: '综合理货员',
        storeName: '大悦城店',
        cityName: '杭州市',
        regionName: '拱墅区',
        laborForm: '兼职',
        salaryDesc: '4000-5000 元/月',
        shiftSummary: '班次可选其一：\n- 10:00-19:00（上午班）\n- 13:00-22:00（中班）',
        jobCategoryName: '零售/超市/理货员',
        distanceKm: 9.4,
      },
    ];
    expect(
      detectJobFactWithoutProvenance(
        reply,
        [],
        [...priorReplies, ...formatJobFactProvenanceTexts(memoryJobs)],
      ),
    ).toBeNull();
  });

  it('formatJobFactProvenanceTexts 只取会被量化正则命中的字段，空摘要不产出', () => {
    const texts = formatJobFactProvenanceTexts([
      null,
      {
        jobId: 1,
        brandName: '肯德基',
        jobName: null,
        storeName: null,
        cityName: null,
        regionName: null,
        laborForm: null,
        salaryDesc: '基础 17 元/时',
        settlementSummary: '月结',
        shiftSummary: null,
        jobCategoryName: null,
        ageRequirement: '18-45岁',
        distanceKm: 2.7,
      },
      {
        jobId: 2,
        brandName: '空壳',
        jobName: null,
        storeName: null,
        cityName: null,
        regionName: null,
        laborForm: null,
        salaryDesc: null,
        jobCategoryName: null,
      },
    ]);
    expect(texts).toEqual(['基础 17 元/时 | 月结 | 18-45岁 | 2.7km']);
  });

  it('本轮有查岗工具即放行', () => {
    expect(
      detectJobFactWithoutProvenance('长风大悦城 M Stand，22-28 元/时', [jobListCall], history),
    ).toBeNull();
  });

  it('本轮调了工单类工具（取消/改约）时"帮你查了下工单"是真查询', () => {
    const cancelCall = { toolName: 'duliday_cancel_work_order', args: {}, result: {} } as never;
    expect(
      detectJobQueryClaimWithoutQuery('我帮你查了下工单，已经取消了', [cancelCall]),
    ).toBeNull();
  });

  it('候选人自己刚说的数字复述回去不算编造；小时数零填充后同一时段视为同一事实', () => {
    expect(
      detectJobFactWithoutProvenance(
        '25元/时那家我记着呢，等下帮你确认',
        [],
        [...history, '那个25元/时的还在招吗'],
      ),
    ).toBeNull();
    expect(
      detectJobFactWithoutProvenance('班次 09:00-18:00', [], ['班次是 9:00-18:00']),
    ).toBeNull();
  });

  it('回指历史的句子豁免', () => {
    expect(
      detectJobFactWithoutProvenance('刚才那家 3.1km 的奥乐齐你要不要看看', [], history),
    ).toBeNull();
  });

  it('没有量化事实不判', () => {
    expect(detectJobFactWithoutProvenance('好的，你方便的时候告诉我', [], history)).toBeNull();
  });
});
