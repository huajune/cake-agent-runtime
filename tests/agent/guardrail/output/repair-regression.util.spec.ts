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
});
