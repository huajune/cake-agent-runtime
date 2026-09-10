import {
  detectJobFactWithoutProvenance,
  detectJobQueryClaimWithoutQuery,
} from '@agent/guardrail/output/rules/job-fact-reconciliation.rule';

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
