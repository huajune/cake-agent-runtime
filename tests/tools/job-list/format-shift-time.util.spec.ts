import {
  composeShiftTimeText,
  formatJobShiftTime,
  formatJobShiftTimeForCandidate,
} from '@tools/job-list/format-shift-time.util';
import { WorkTimeContractError } from '@sponge/work-time.types';
import { scheduledJob, flexibleJob } from '../../helpers/job-schedule.fixture';
import { mapJobsToRecommendedSummaries } from '@tools/job-list/job-summary.util';
import { formatJobsToMarkdown } from '@tools/job-list/render.util';
import { detectHumanServicePhraseLeak } from '@agent/guardrail/output/rules/internal-info-leaks.rule';

describe('共享结构化班次展示与契约', () => {
  it('固定排班逐档展示、接受全部，不把长档猜成灵活窗口', () => {
    const job = scheduledJob(1, '固定排班', [['10:00', '22:00']]);
    const text = formatJobShiftTime(job);
    expect(text).toContain('需接受全部班次');
    expect(text).toContain('班次跨度 12 小时');
    expect(text).not.toContain('窗口');
  });
  it('组合排班任选一个完整班次，摘要、详情与卡片关系一致', () => {
    const job = scheduledJob(2, '组合排班制', [
      ['07:00', '14:00'],
      ['07:00', '15:00'],
    ]);
    const text = formatJobShiftTime(job);
    expect(text).toContain('任选其中一档完整班次');
    expect(text).toContain('07:00-14:00');
    expect(text).toContain('07:00-15:00');
    expect(mapJobsToRecommendedSummaries([job])[0].shiftSummary).toBe(text);
    const md = formatJobsToMarkdown([job], 1, 1, 20, {
      includeBasicInfo: true,
      includeJobSalary: false,
      includeWelfare: false,
      includeHiringRequirement: false,
      includeWorkTime: true,
      includeInterviewProcess: false,
    });
    expect(md).toContain(text);
    expect(md).not.toContain('组合排班制，下面列出的');
  });
  it('灵活排班展示排班区间、门店按可上班时间安排的每班时长和须上完整班，不写成区间内自选', () => {
    const text = formatJobShiftTime(flexibleJob(3, '22:00', '07:00', '8', true));
    expect(text).toBe(
      '灵活排班：排班区间 22:00-次日07:00（可排夜班），门店按候选人可上班时间在区间内安排每班 8 小时，需完整上完一班',
    );
    expect(text).not.toMatch(/任选|自选|待确认|整个排班区间/);
    expect(text).not.toContain('9 小时');
  });
  it('超过12小时的班次写时段内排班6-8小时并留出与店长沟通的余地，不写班次跨度', () => {
    const text = formatJobShiftTime(scheduledJob(7, '固定排班', [['09:30', '22:30']]));
    expect(text).toBe(
      '固定排班（在以下时段内排班）：09:30-22:30（时段内排班 6-8 小时，实际可面试时和店长沟通，可排上午班、中班、下午班、晚班）',
    );
    const combo = formatJobShiftTime(
      scheduledJob(8, '组合排班制', [
        ['08:00', '24:00'],
        ['16:00', '24:00'],
      ]),
    );
    expect(combo).toContain('08:00-次日00:00（时段内排班 6-8 小时，实际可面试时和店长沟通');
    expect(combo).toContain('16:00-次日00:00（下午班、晚班，班次跨度 8 小时）');
    expect(combo).not.toContain('班次跨度 16 小时');
    expect(combo).toMatch(/^组合排班制（任选其中一档）：/);
  });
  it('固定排班多档按运营口径说明是否同一天上', () => {
    expect(
      formatJobShiftTime(
        scheduledJob(9, '固定排班', [
          ['07:00', '16:00'],
          ['16:00', '02:00'],
        ]),
      ),
    ).toContain('固定排班（各班次不在同一天上，需全部都能接受）');
    expect(
      formatJobShiftTime(
        scheduledJob(10, '固定排班', [
          ['08:00', '12:00'],
          ['15:00', '19:00'],
        ]),
      ),
    ).toContain('固定排班（需接受全部班次，是否同一天连着上未明确）');
  });
  it('固定排班多档说明可原样转述，不触发人设露馅守卫', () => {
    const text = formatJobShiftTime(
      scheduledJob(11, '固定排班', [
        ['08:00', '12:00'],
        ['15:00', '19:00'],
      ]),
    );
    expect(detectHumanServicePhraseLeak(`给你推荐一个岗位：\n班次：${text}`)).toBeNull();
  });
  it('跨日整档展示次日，24点也统一为次日零点', () => {
    expect(formatJobShiftTime(scheduledJob(4, '固定排班', [['18:00', '02:00']]))).toContain(
      '18:00-次日02:00',
    );
    expect(formatJobShiftTime(scheduledJob(4, '固定排班', [['18:00', '24:00']]))).toContain(
      '18:00-次日00:00',
    );
  });
  it('非整小时跨度按小时加分钟展示，不输出长小数', () => {
    const text = formatJobShiftTime(scheduledJob(5, '固定排班', [['10:00', '16:20']]));
    expect(text).toContain('班次跨度 6 小时 20 分钟');
    expect(text).not.toMatch(/\d\.\d/);
    expect(formatJobShiftTime(scheduledJob(5, '固定排班', [['21:00', '21:30']]))).toContain(
      '（夜班，班次跨度 30 分钟）',
    );
    expect(formatJobShiftTime(flexibleJob(6, '10:00', '20:00', '5.5'))).toContain(
      '每班 5 小时 30 分钟',
    );
  });
  it('班次没有标签时不输出多余分隔符', () => {
    const text = formatJobShiftTime(scheduledJob(6, '固定排班', [['20:30', '21:30']]));
    expect(text).toContain('20:30-21:30（班次跨度 1 小时）');
    expect(text).not.toContain('（，');
  });
  it('未请求工作时间可以为空，但不把非法已提供字段变成空数据', () => {
    expect(composeShiftTimeText(undefined)).toBeNull();
    expect(() => composeShiftTimeText({})).toThrow(WorkTimeContractError);
  });
});

describe('候选人卡片的简短班次（2026-10-14 用户确认口径）', () => {
  it.each([
    ['固定·单个班次', scheduledJob(1, '固定排班', [['12:00', '15:00']]), '12:00-15:00（3小时）'],
    [
      '固定·单个班次超过12小时',
      scheduledJob(2, '固定排班', [['09:30', '22:30']]),
      '09:30-22:30 间排 6-8 小时，面试时可和店长沟通',
    ],
    [
      '固定·多档不在同一天',
      scheduledJob(3, '固定排班', [
        ['07:00', '16:00'],
        ['16:00', '02:00'],
        ['23:00', '07:00'],
      ]),
      '07:00-16:00 / 16:00-次日2:00 / 23:00-次日7:00 轮班，都要能上',
    ],
    [
      '固定·多档未明确是否同一天',
      scheduledJob(4, '固定排班', [
        ['08:00', '14:00'],
        ['15:00', '20:00'],
      ]),
      '08:00-14:00 和 15:00-20:00，两个都要能上',
    ],
    [
      '组合·普通',
      scheduledJob(5, '组合排班制', [
        ['07:00', '15:00'],
        ['15:00', '23:00'],
        ['23:00', '07:00'],
      ]),
      '07:00-15:00 / 15:00-23:00 / 23:00-次日7:00 三选一',
    ],
    [
      '组合·含超长档',
      scheduledJob(6, '组合排班制', [
        ['07:00', '24:00'],
        ['16:00', '23:00'],
      ]),
      '07:00-24:00 间排 6-8 小时，或 16:00-23:00，二选一',
    ],
    ['灵活', flexibleJob(7, '05:00', '23:00', '8'), '05:00-23:00 间按你的时间排，每次 8 小时'],
    [
      '灵活·24小时店',
      flexibleJob(8, '05:00', '05:00', '8', true),
      '24 小时店，按你的时间排，每次 8 小时',
    ],
  ])('%s', (_, job, expected) => {
    const text = formatJobShiftTimeForCandidate(job);
    expect(text).toBe(expected);
    expect(text).not.toMatch(/固定排班|组合排班|灵活排班|班次跨度|上午班|中班|下午班|晚班|夜班/);
  });
});
