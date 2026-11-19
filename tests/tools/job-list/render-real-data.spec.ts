import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { RedisService } from '@infra/redis/redis.service';
import { SpongeBiService } from '@sponge/sponge-bi.service';
import { SpongeService } from '@sponge/sponge.service';
import type { InvalidWorkTimeJob, JobDetail } from '@sponge/sponge.types';
import { WorkTimeContractError } from '@sponge/work-time.types';
import { composeShiftTimeText } from '@tools/job-list/format-shift-time.util';
import {
  classifyScheduleSemantic,
  matchScheduleConstraint,
} from '@tools/job-list/schedule-semantic.util';
import { formatJobsToMarkdown, ProgressiveDisclosureFlags } from '@tools/job-list/render.util';
import { buildJobPolicyAnalysis } from '@tools/job-list/job-policy-parser';

/**
 * 用海绵网关新接口拉取的全量真实岗位（scripts/probe-output-jobs.json）走查岗工具使用的逐岗校验，再做渲染冒烟：
 * - 每条上游岗位都应有去向，班次不合规的保留严格校验的原因，其余进入渲染
 * - workTime 班次文案、排班语义、markdown 渲染均不得抛错
 * - 抽样断言新结构字段确实被渲染（排班周期 / 可排时段 / 班次文案）
 * - 三类排班（满足其中一个 / 满足所有 / 灵活排班）均有覆盖
 *
 * 数据文件缺失时（CI 无 token）整组跳过，不阻断流水线。
 * 重新生成数据：node scripts/probe-job-list-new-endpoint.js
 */
const REAL_DATA_PATH = path.resolve(__dirname, '../../../scripts/probe-output-jobs.json');
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
  let rawJobs: JobDetail[];
  let jobs: JobDetail[];
  let skipped: InvalidWorkTimeJob[];

  beforeAll(async () => {
    rawJobs = JSON.parse(fs.readFileSync(REAL_DATA_PATH, 'utf8')) as JobDetail[];
    const module = await Test.createTestingModule({
      providers: [
        SpongeService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            DULIDAY_API_TOKEN: 'fixture-only',
            SPONGE_API_BASE_URL: 'https://fixture.invalid',
          }),
        },
        { provide: SpongeBiService, useValue: {} },
        { provide: RedisService, useValue: {} },
        {
          provide: HostingMemberConfigService,
          useValue: { resolveDulidayToken: async () => null },
        },
      ],
    }).compile();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        Response.json({ code: 0, data: { result: rawJobs, total: rawJobs.length } }),
      );
    try {
      const result = await module.get(SpongeService).fetchJobs({
        options: ALL_FLAGS,
        invalidWorkTime: 'skip',
      });
      jobs = result.jobs;
      skipped = result.skippedInvalidWorkTime ?? [];
      expect(result.total).toBe(rawJobs.length);
    } finally {
      fetch.mockRestore();
      await module.close();
    }
  });

  it('accounts for every raw job and identifies each rejected schedule by its strict error', () => {
    expect(rawJobs.length).toBeGreaterThan(100);
    const rejected: InvalidWorkTimeJob[] = [];
    const acceptedIds: Array<number | null> = [];
    for (const job of rawJobs) {
      const jobId = job.basicInfo?.jobId ?? null;
      try {
        composeShiftTimeText(job.workTime);
        acceptedIds.push(jobId);
      } catch (error) {
        if (!(error instanceof WorkTimeContractError)) throw error;
        rejected.push({
          jobId,
          brandName: job.basicInfo?.brandName ?? null,
          reason: error.message,
        });
      }
    }
    expect(skipped).toEqual(rejected);
    expect(jobs.map((job) => job.basicInfo?.jobId ?? null)).toEqual(acceptedIds);
    expect(jobs.length + skipped.length).toBe(rawJobs.length);
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
