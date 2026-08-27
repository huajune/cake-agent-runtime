import { detectRepairRegression } from '@agent/guardrail/output/repair-regression.util';

/**
 * 回归闸门用例全部取自 2026-07-24 守卫审计的生产 trace（文本节选）。
 */
describe('detectRepairRegression', () => {
  // trace batch_6a609570…：逐行报名表被 replan 压成一句话流水账（已投递）。
  const bookingFormFirst = [
    '薪资是每月 15 号发，月结算。',
    '面试的话，这家是线下面试，时间是周一到周五下午 1 点半到 4 点半。最近明天（周四）就能约，你看哪个时间段方便？',
    '要帮你登记预约的话，先把下面资料发我：',
    '姓名：',
    '联系电话：',
    '性别：',
    '年龄：',
    '面试时间：（比如 明天下午 2 点）',
    '应聘门店：上海佘山旭辉里店',
    '学历：',
    '健康证：（有/无）',
    '身份：（学生/社会人士）',
    '应聘岗位：洗碗工',
  ].join('\n');
  const bookingFormRevised = [
    '薪资是每月15号发。上岗时间看面试进度，登记后我帮你提交预约，面试通过一般几天内就能排班。',
    '你看方便的话，发下你的姓名、电话和年龄，我这边直接帮你录入提交。',
  ].join('\n');

  // trace batch_6a606ac5…：首版 4 个岗位详情，修复版反转成"附近没查到在招岗位"（已投递）。
  const jobListFirst = [
    '川沙百联附近有的',
    '肯德基（新源店）- 全天排班，离川沙百联1.1公里',
    '薪资：基础17元/时，月累计满100小时21元/时，综合3000-6000元/月，每周三发薪',
    '成都你六姐（川沙浦乐汇店）- 前厅服务员，离川沙百联1.7公里',
    '班次：11:00-14:00（午高峰，约3小时），做三休四',
    '最接近你时间的是成都你六姐前厅那个，11:00-14:00，但只有3小时，不是6小时',
  ].join('\n');
  const jobListRevised = [
    '川沙百联那边暂时没查到在招的岗位',
    '你9:30-15:30这个时间段可以的，肯德基新源店是灵活排班，能配合你这个时段',
  ].join('\n');

  it('detects a booking form collapsed into a one-liner (structure_collapsed)', () => {
    expect(detectRepairRegression(bookingFormFirst, bookingFormRevised)).toBe(
      'structure_collapsed',
    );
  });

  it('detects the production job-list reversal as a regression', () => {
    expect(detectRepairRegression(jobListFirst, jobListRevised)).not.toBeNull();
  });

  it('detects polarity reversal when structure is mostly kept but jobs become "none found"', () => {
    const first = [
      '肯德基（新源店）- 全天排班，离川沙百联1.1公里',
      '薪资：基础17元/时，每周三发薪',
    ].join('\n');
    const revised = '我查了下，川沙百联附近暂时没有在招的岗位，有新岗位我第一时间通知你。';
    expect(detectRepairRegression(first, revised)).toBe('polarity_reversed');
  });

  // 2026-07-30 审计 P2-8：岗位事实原按"行"统计，首版写成一段散文时计数恒为 1，
  // >=2 的门槛永远够不到——trace batch_6a6726d4… 首版散文式给出最高薪岗位、修复版
  // 反转成"附近 10 公里内没岗位"，两个检测器都没拦住并已投递。
  it('detects polarity reversal when the first reply is a single prose paragraph', () => {
    const first =
      '你要工资高一点、累点无所谓的话，奥乐齐分拣这个岗位比较合适，首月保底 6760 元，离你 3.2 公里，班次是 07:00-19:00。';
    const revised = '你附近 10 公里内暂时没找到合适的岗位，先帮你进兼职群，有新岗我第一时间叫你。';
    expect(detectRepairRegression(first, revised)).toBe('polarity_reversed');
  });

  it('accepts deleting fabricated job cards when all job-list calls had no evidence', () => {
    const first = [
      '帮你查了下，附近有几家在招的：',
      '肯德基-深圳爱联店（距离约0.5km）',
      '服务员-小时工，22元/小时，每月15号发薪',
      '必胜客-深圳龙岗万达店（距离约2.8km）',
      '服务员-小时工，23元/小时，每月15号发薪',
      'M Stand-深圳大运天地店（距离约3.2km）',
      '咖啡师-全职，综合薪资6000-8000元/月，每月20号发薪',
    ].join('\n');
    const revised =
      '帮你查了下，目前暂时没查到你位置附近匹配的在招岗位。我已经邀请你进深圳餐饮兼职群，群里会发最新岗位信息。';

    expect(
      detectRepairRegression(first, revised, {
        jobEvidenceAvailable: false,
      }),
    ).toBeNull();
  });

  it('keeps rejecting structure collapse without explicit empty-job evidence', () => {
    const first = [
      '必胜客保利大都汇，日结当天发薪',
      '班次 07:00-15:00、11:00-20:00、15:00-23:00',
      '基础 22 元/小时，要求 18-45 岁',
    ].join('\n');
    const revised = '这个我还没查过，暂时没查到在招的岗位信息，我先帮你查一下再回复你。';

    expect(
      detectRepairRegression(first, revised, {
        jobEvidenceAvailable: undefined,
      }),
    ).not.toBeNull();
  });

  it('still rejects deleting grounded job cards when a job-list call had evidence', () => {
    const first = [
      '肯德基-深圳爱联店（距离约0.5km）',
      '服务员-小时工，22元/小时',
      '必胜客-深圳龙岗万达店（距离约2.8km）',
      '服务员-小时工，23元/小时',
    ].join('\n');
    const revised = '目前暂时没查到你位置附近匹配的在招岗位。';

    expect(
      detectRepairRegression(first, revised, {
        jobEvidenceAvailable: true,
      }),
    ).not.toBeNull();
  });

  // trace batch_6a616f5b…：结算口径精确化，三家门店结构逐字保留——最优修复，不得误伤。
  it('accepts a good repair that keeps structure and refines facts', () => {
    const first = [
      '肯德基（西岸滨江店），离你 7.7km，上班时间 06:30-23:30，做六休一。基础 17 元/时，满 100 小时涨到 22，最高 28 元/时。',
      '肯德基（联想智慧园店），离你 7.8km，上班时间 05:00-23:30，做五休二。薪资一样是周结 17 元/小时起。',
      '这几家离你稍微有点远，你看哪个方向通勤方便些？',
    ].join('\n');
    const revised = [
      '肯德基（西岸滨江店），离你 7.7km，上班时间 06:30-23:30，做六休一。基础时薪 17 元，周结；阶梯差价按月结算，最高 28 元/小时。',
      '肯德基（联想智慧园店），离你 7.8km，上班时间 05:00-23:30，做五休二。基础时薪 17 元周结，阶梯差价月结。',
      '这几家离你稍微有点远，你看哪个方向通勤方便些？',
    ].join('\n');
    expect(detectRepairRegression(first, revised)).toBeNull();
  });

  it('accepts legitimate shortening of unstructured prose', () => {
    const first =
      '这个岗位排班是固定的，每周至少要上岗 6 天，你一周能来 4 天的话可能不太匹配。你这边能调整到一周 6 天吗？还是说想看看其他排班更灵活的岗位？';
    const revised = '这家要求每周至少上岗 6 天，你一周 4 天对不上。要帮你看看排班更灵活的岗位吗？';
    expect(detectRepairRegression(first, revised)).toBeNull();
  });

  it('does not flag reversal when the first reply already said no jobs were found', () => {
    const first = [
      'M Stand在安华汇附近10公里内暂时没找到合适的岗位',
      '离你最近的备选是 2.3公里 的另一家，基础 20 元/时',
      '我先帮你进餐饮兼职群，后续有合适的我会第一时间@你',
    ].join('\n');
    const revised = '咱们这边在白云区一带附近暂时没找到合适的岗位，我先帮你进餐饮兼职群。';
    expect(detectRepairRegression(first, revised)).toBeNull();
  });

  it('returns null for identical texts', () => {
    expect(detectRepairRegression(bookingFormFirst, bookingFormFirst)).toBeNull();
  });

  // ============ fact_mutated（2026-07-27 审计，trace batch_6a630be4…） ============

  describe('fact_mutated: 已确认日期星期被 repair 翻错', () => {
    // 生产案（文本节选）：2026-07-28 真实是周二，首版来自工具盖章，replan 改成周一后投递。
    const NOW = new Date(2026, 6, 24); // 2026-07-24（案发当天）
    const weekdayFirst =
      '资料收到啦，已帮你成功提交报名！\n你的面试安排在 7 月 28 日（周二）上午 10:30。\n地点：哈根达斯（上海又一城店）。';
    const weekdayRevised =
      '资料收到啦，正在帮你核对并提交报名，稍后给你回执。\n你的面试安排在 7 月 28 日（周一）上午 10:30。\n地点：哈根达斯（上海又一城店）。';

    it('detects the production weekday flip (周二→周一, first was correct)', () => {
      expect(detectRepairRegression(weekdayFirst, weekdayRevised, { now: NOW })).toBe(
        'fact_mutated',
      );
    });

    it('does not flag when the repair corrects a wrong weekday (周一→周二)', () => {
      expect(detectRepairRegression(weekdayRevised, weekdayFirst, { now: NOW })).not.toBe(
        'fact_mutated',
      );
    });

    it('does not flag when weekday is unchanged', () => {
      const revisedSameWeekday = weekdayFirst.replace('已帮你成功提交报名！', '报名提交好啦！');
      expect(detectRepairRegression(weekdayFirst, revisedSameWeekday, { now: NOW })).toBeNull();
    });

    it('handles 星期X notation and spaced dates', () => {
      const first = '面试定在7月28日（星期二）下午2点。地址在杨浦区淞沪路8号。';
      const revised = '面试定在 7 月 28 日（星期三）下午 2 点。地址在杨浦区淞沪路8号。';
      expect(detectRepairRegression(first, revised, { now: NOW })).toBe('fact_mutated');
    });

    it('does not flag dates that only appear in one side', () => {
      const first = '面试定在7月28日（周二）下午2点。';
      const revised = '面试改到7月29日（周三）下午2点，你看方便吗？';
      expect(detectRepairRegression(first, revised, { now: NOW })).toBeNull();
    });

    it('infers year across the December/January boundary', () => {
      // 2027-01-05 真实是周二；now 在 2026 年末，就近年份必须推断为 2027。
      const yearEnd = new Date(2026, 11, 28); // 2026-12-28
      const first = '面试安排在1月5日（周二）上午10点。';
      const revised = '面试安排在1月5日（周一）上午10点。';
      expect(detectRepairRegression(first, revised, { now: yearEnd })).toBe('fact_mutated');
    });
  });

  // ====== commitment_downgraded（2026-07-27 审计，trace batch_6a630be4… 同案另一处伤） ======

  describe('commitment_downgraded: 既成 booking 被降级成进行时', () => {
    const committed =
      '本轮已成功执行副作用工具：duliday_interview_booking（已生效不可撤销；重写时不要声称未发生，也不要重复执行）';
    const first = '资料收到啦，已帮你成功提交报名！\n你的面试安排在 7 月 28 日（周二）上午 10:30。';
    const downgraded =
      '资料收到啦，正在帮你核对并提交报名，稍后给你回执。\n你的面试安排在 7 月 28 日（周二）上午 10:30。';

    it('detects the production success→pending downgrade', () => {
      expect(
        detectRepairRegression(first, downgraded, {
          committedSideEffects: committed,
          now: new Date(2026, 6, 24),
        }),
      ).toBe('commitment_downgraded');
    });

    it('does not fire without booking in committed side effects', () => {
      expect(
        detectRepairRegression(first, downgraded, {
          committedSideEffects: '本轮已成功执行副作用工具：invite_to_group（已生效不可撤销）',
          now: new Date(2026, 6, 24),
        }),
      ).toBeNull();
    });

    it('does not fire when the revised reply still asserts success', () => {
      const revisedStillDone =
        '报名已经帮你提交成功啦！面试安排在 7 月 28 日（周二）上午 10:30，稍后留意面试通知。';
      expect(
        detectRepairRegression(first, revisedStillDone, {
          committedSideEffects: committed,
          now: new Date(2026, 6, 24),
        }),
      ).toBeNull();
    });

    it('does not fire when the first reply never claimed success', () => {
      const firstPending = '资料收到啦，我这边帮你核对下就提交报名。';
      expect(
        detectRepairRegression(firstPending, downgraded, {
          committedSideEffects: committed,
          now: new Date(2026, 6, 24),
        }),
      ).toBeNull();
    });
  });

  // ====== 首版即违规结构的豁免（2026-08-27 生产案，trace batch_6a8faabb…） ======

  describe('structure_collapsed 豁免：首版整体是内部分析泄漏', () => {
    // 生产案（文本节选）：首版把内部分析当回复输出（工具名/规则引用/筛选清单），
    // internal_output_leak 正确 block；repair 重写出合格话术且二审 pass，却被
    // structure_collapsed 判退化，两版都不投——候选人在关键意向节点整轮静默。
    const leakedAnalysisFirst = [
      '根据查询结果，我来分析一下符合候选人要求的岗位：',
      '**候选人要求：**',
      '- 白天上班',
      '- 做五休二（每周最多5天）',
      '- 税前6000以上',
      '**筛选结果：**',
      '成都你六姐的岗位都不符合要求：',
      '- 薪资都是1000-3000元/月，远低于6000',
      '- 大部分要求每周至少6-7天，不符合做五休二',
      '奥乐齐的岗位：',
      '1. **通岗店员**：4000-5500元/月，每周6天 - 薪资不够6000，且每周6天不符合做五休二',
      '2. **分拣打包**：6200-9800元/月，每周6天 - 薪资符合6000+，但每周6天不符合做五休二',
      '根据规则："候选人说班次硬约束后，duliday_job_list会按约束剔除不兼容岗位并在queryMeta.scheduleFilter里说明剔除数量与理由"',
      '但queryMeta.scheduleFilter显示excludedCount=0，说明没有岗位被剔除。',
    ].join('\n');
    const goodRepair = [
      '我帮你查了下，附近符合白天上班、税前6000以上的岗位只有奥乐齐分拣打包，10公里，6200-9800元/月，但这家要求每周上6天，和你做五休二有点冲突',
      '其他薪资高的岗位要么班次不合适，要么要求每周6天',
      '你看奥乐齐这家能不能接受每周6天',
    ].join('\n');

    it('accepts stripping analysis scaffolding when first was blocked as internal_output_leak', () => {
      expect(
        detectRepairRegression(leakedAnalysisFirst, goodRepair, {
          firstBlockedRuleIds: ['internal_output_leak'],
          jobEvidenceAvailable: true,
        }),
      ).toBeNull();
    });

    it('documents the pre-fix false positive: same pair without rule context is flagged', () => {
      expect(
        detectRepairRegression(leakedAnalysisFirst, goodRepair, { jobEvidenceAvailable: true }),
      ).toBe('structure_collapsed');
    });

    it('meta_narration_reply / invalid_model_output share the exemption', () => {
      for (const ruleId of ['meta_narration_reply', 'invalid_model_output']) {
        expect(
          detectRepairRegression(leakedAnalysisFirst, goodRepair, {
            firstBlockedRuleIds: [ruleId],
            jobEvidenceAvailable: true,
          }),
        ).toBeNull();
      }
    });

    it('does not exempt collapse when first was blocked by a non-leak rule', () => {
      expect(
        detectRepairRegression(bookingFormFirst, bookingFormRevised, {
          firstBlockedRuleIds: ['booking_done_claim_without_submission'],
        }),
      ).toBe('structure_collapsed');
    });

    it('exemption only disables the structure detector, not polarity/fact checks', () => {
      const reversed = '你附近暂时没有在招的岗位，有新岗我第一时间通知你。';
      expect(
        detectRepairRegression(leakedAnalysisFirst, reversed, {
          firstBlockedRuleIds: ['internal_output_leak'],
          jobEvidenceAvailable: true,
        }),
      ).toBe('polarity_reversed');

      const weekdayFirst = '已帮你提交报名！面试安排在 7 月 28 日（周二）上午 10:30。';
      const weekdayFlipped = '已帮你提交报名！面试安排在 7 月 28 日（周一）上午 10:30。';
      expect(
        detectRepairRegression(weekdayFirst, weekdayFlipped, {
          firstBlockedRuleIds: ['internal_output_leak'],
          now: new Date(2026, 6, 24),
        }),
      ).toBe('fact_mutated');
    });
  });
});
