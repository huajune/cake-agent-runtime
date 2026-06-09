import * as fs from 'fs';
import * as path from 'path';
import { composeShiftTimeText } from '@tools/utils/format-shift-time.util';
import {
  classifyScheduleSemantic,
  matchScheduleConstraint,
} from '@tools/utils/schedule-semantic.util';
import { formatJobsToMarkdown, ProgressiveDisclosureFlags } from '@tools/duliday/job-list/render.util';
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';

/**
 * 用海绵网关新接口拉取的全量真实岗位（scripts/probe-output-jobs.json，约 430 条 =
 * 平台当前可拉取的全部在招/非在招岗位）做端到端冒烟：
 * - workTime 班次文案、排班语义、markdown 渲染均不得抛错
 * - 抽样断言新结构字段确实被渲染（排班周期 / 可排时段 / 班次文案）
 * - 三类排班（满足其中一个 / 满足所有 / 灵活排班）均有覆盖
 *
 * 数据文件缺失时（CI 无 token）整组跳过，不阻断流水线。
 * 重新生成数据：node scripts/probe-job-list-new-endpoint.js
 */
const REAL_DATA_PATH = path.resolve(__dirname, '../../../../scripts/probe-output-jobs.json');
const hasRealData = fs.existsSync(REAL_DATA_PATH);
const describeIf = hasRealData ? describe : describe.skip;

const ALL_FLAGS: ProgressiveDisclosureFlags = {
  includeBasicInfo: true,
  includeJobSalary: true,
  includeWelfare: true,
  includeHiringRequirement: true,
  includeWorkTime: true,
  includeInterviewProcess: true,
};

describeIf('real gateway job data (full inventory)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobs: any[] = hasRealData ? JSON.parse(fs.readFileSync(REAL_DATA_PATH, 'utf8')) : [];

  it('loaded a non-trivial number of real jobs', () => {
    expect(jobs.length).toBeGreaterThan(100);
  });

  it('composeShiftTimeText never throws and yields shift text for most jobs', () => {
    let withShift = 0;
    for (const job of jobs) {
      const text = composeShiftTimeText(job.workTime);
      if (text) withShift++;
    }
    // 真实数据里绝大多数岗位都有 dayWorkTime 时段，应有较高命中率
    expect(withShift).toBeGreaterThan(jobs.length * 0.6);
  });

  it('classifyScheduleSemantic never throws and never returns empty', () => {
    for (const job of jobs) {
      const analysis = buildJobPolicyAnalysis(job);
      const semantics = classifyScheduleSemantic({
        workTimeText: job.workTime ? JSON.stringify(job.workTime) : '',
        interviewRemark: analysis.normalizedRequirements.interviewRemark,
        requirementRemark: analysis.normalizedRequirements.remark,
      });
      expect(Array.isArray(semantics)).toBe(true);
      expect(semantics.length).toBeGreaterThan(0);
      // 与 onlyWeekends 约束匹配不得抛错
      expect(() => matchScheduleConstraint(semantics, { onlyWeekends: true })).not.toThrow();
    }
  });

  it('renders每个岗位 markdown without throwing and includes new workTime sections', () => {
    let renderedWorkTimeSection = 0;
    for (const job of jobs) {
      const md = formatJobsToMarkdown([job], 1, 1, 10, ALL_FLAGS);
      expect(typeof md).toBe('string');
      if (md.includes('### 工作时间')) renderedWorkTimeSection++;
      // 不得残留旧结构渲染假设导致的明显空洞
      expect(md).toContain('### 基本信息');
    }
    expect(renderedWorkTimeSection).toBeGreaterThan(jobs.length * 0.6);
  });

  it('renders at least one job with 排班周期 and 可排时段/班次 from new structure', () => {
    const combined = jobs.map((job) => formatJobsToMarkdown([job], 1, 1, 10, ALL_FLAGS)).join('\n');
    expect(combined).toContain('排班周期');
    expect(/可排时段|上下班时间|班次/.test(combined)).toBe(true);
  });
});
