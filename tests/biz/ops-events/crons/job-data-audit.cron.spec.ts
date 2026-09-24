import { Logger } from '@nestjs/common';
import {
  JOB_DATA_AUDIT_LOCK_KEY,
  JobDataAuditCronService,
} from '@biz/ops-events/crons/job-data-audit.cron';
import type { JobDetail } from '@sponge/sponge.types';
import {
  buildSpongeJobFixture,
  loadSpongeJobFixtures,
  SPONGE_JOB_FIXTURE_IDS as IDS,
} from '../../../fixtures/sponge-jobs';

type ConfigMap = Record<string, string | undefined>;

function makeService(configMap: ConfigMap) {
  const spongeService = { fetchJobs: jest.fn() };
  const alertNotifier = { sendAlert: jest.fn().mockResolvedValue(true) };
  const redisService = {
    setNx: jest.fn().mockResolvedValue(true),
    del: jest.fn().mockResolvedValue(1),
  };
  const configService = {
    get: (key: string, fallback?: string) => configMap[key] ?? fallback,
  };
  const service = new JobDataAuditCronService(
    spongeService as never,
    alertNotifier as never,
    redisService as never,
    configService as never,
  );
  return { service, spongeService, alertNotifier, redisService };
}

const PROD_ENABLED: ConfigMap = { NODE_ENV: 'production', JOB_DATA_AUDIT_ENABLED: 'true' };

function page(jobs: JobDetail[], total: number) {
  return { jobs, total };
}

describe('JobDataAuditCronService.runOnce', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('六分区全开分页拉取、按 jobId 去重，有问题时只发一条按日期去重的告警', async () => {
    const { service, spongeService, alertNotifier } = makeService(PROD_ENABLED);
    const fixtures = loadSpongeJobFixtures();
    const first = fixtures.slice(0, 50);
    const duplicate = fixtures[0];
    // 22 条真实样例补到 50 条一整页；第二页 1 条重复 + 1 条造出的发薪日为空
    while (first.length < 50) {
      first.push(
        buildSpongeJobFixture(IDS.GUOSHUHAO_BPO_HOUSEHOLD_EXCLUDE, (draft) => {
          draft.basicInfo!.jobId = 900000 + first.length;
        }),
      );
    }
    const paydayMissing = buildSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW, (draft) => {
      draft.basicInfo!.jobId = 777001;
      (
        draft.jobSalary as { salaryScenarioList: Record<string, unknown>[] }
      ).salaryScenarioList[0].payday = '';
    });
    spongeService.fetchJobs
      .mockResolvedValueOnce(page(first, 52))
      .mockResolvedValueOnce(page([duplicate, paydayMissing], 52));

    const result = await service.runOnce();

    expect(spongeService.fetchJobs).toHaveBeenCalledTimes(2);
    expect(spongeService.fetchJobs).toHaveBeenNthCalledWith(1, {
      pageNum: 1,
      pageSize: 50,
      options: {
        includeBasicInfo: true,
        includeJobSalary: true,
        includeWelfare: true,
        includeHiringRequirement: true,
        includeWorkTime: true,
        includeInterviewProcess: true,
      },
    });
    expect(result.scanned).toBe(51);
    expect(result.total).toBe(52);
    expect(result.truncated).toBe(false);
    expect(result.byKind.payday_missing).toBe(1);
    expect(result.byKind.stair_text_without_structure).toBe(5);
    expect(result.alerted).toBe(true);

    expect(alertNotifier.sendAlert).toHaveBeenCalledTimes(1);
    const context = alertNotifier.sendAlert.mock.calls[0][0];
    expect(context).toMatchObject({
      code: 'ops.job_data_audit',
      severity: 'warning',
      source: { subsystem: 'ops-events', component: 'job-data-audit', trigger: 'cron' },
      dedupe: { key: `ops.job_data_audit:${result.reportDate}` },
    });
    expect(context.summary).toContain('51 个在招岗位发现 7 处录入问题');
    expect(context.summary).toContain('发薪日为空 1');
    const report = context.diagnostics.payload.report as string;
    expect(report).toContain('- 777001 肯德基：正式（周结算）发薪日 payday 为空');
    expect(report).toContain(
      `- ${IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT} 必胜客：结构化节假日薪资「无薪资」`,
    );
    // 不列门店联系人 / 地址
    expect(report).not.toContain('示例门店');
    expect(report).not.toMatch(/1[3-9]\d{9}/);
  });

  it('没有问题时只记日志不发告警', async () => {
    const { service, spongeService, alertNotifier } = makeService(PROD_ENABLED);
    spongeService.fetchJobs.mockResolvedValueOnce(
      page(
        [
          loadSpongeJobFixtures().find(
            (j) => j.basicInfo?.jobId === IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW,
          )!,
        ],
        1,
      ),
    );

    const result = await service.runOnce();

    expect(result.issues).toEqual([]);
    expect(result.alerted).toBe(false);
    expect(alertNotifier.sendAlert).not.toHaveBeenCalled();
  });

  it('分页触顶时标记 truncated 并写进告警摘要，不再继续翻页', async () => {
    const { service, spongeService, alertNotifier } = makeService({
      ...PROD_ENABLED,
      JOB_DATA_AUDIT_MAX_PAGES: '1',
    });
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      buildSpongeJobFixture(IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT, (draft) => {
        draft.basicInfo!.jobId = 800000 + i;
      }),
    );
    spongeService.fetchJobs.mockResolvedValue(page(fullPage, 120));

    const result = await service.runOnce();

    expect(spongeService.fetchJobs).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(50);
    expect(alertNotifier.sendAlert.mock.calls[0][0].summary).toContain('扫描已截断');
  });

  it('某页 fetchJobs 抛错不中断整轮：已拉到的页照常体检，truncated=true 且告警带「拉取被截断」', async () => {
    const { service, spongeService, alertNotifier } = makeService(PROD_ENABLED);
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      buildSpongeJobFixture(IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT, (draft) => {
        draft.basicInfo!.jobId = 800000 + i;
      }),
    );
    spongeService.fetchJobs
      .mockResolvedValueOnce(page(fullPage, 120))
      .mockRejectedValueOnce(new Error('海绵 502'));

    const result = await service.runOnce();

    expect(spongeService.fetchJobs).toHaveBeenCalledTimes(2);
    expect(result.scanned).toBe(50);
    expect(result.truncated).toBe(true);
    expect(result.fetchError).toBe('第 2 页拉取失败: 海绵 502');
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.alerted).toBe(true);
    const context = alertNotifier.sendAlert.mock.calls[0][0];
    expect(context.summary).toContain('拉取被截断（第 2 页拉取失败: 海绵 502）');
    expect(context.diagnostics.payload.fetchError).toBe('第 2 页拉取失败: 海绵 502');
  });

  it('第一页就拉取失败：零问题也要告警说明拉取被截断，不能静默当「今天没问题」', async () => {
    const { service, spongeService, alertNotifier } = makeService(PROD_ENABLED);
    spongeService.fetchJobs.mockRejectedValueOnce(new Error('海绵 504'));

    const result = await service.runOnce();

    expect(result).toMatchObject({ scanned: 0, truncated: true, issues: [], alerted: true });
    expect(alertNotifier.sendAlert.mock.calls[0][0].summary).toContain('拉取被截断');
  });

  it('时间窗耗尽时不再发起下一页', async () => {
    const { service, spongeService } = makeService({
      ...PROD_ENABLED,
      JOB_DATA_AUDIT_TIME_BUDGET_MS: '0',
    });
    spongeService.fetchJobs.mockResolvedValue(page([], 0));

    const result = await service.runOnce();

    expect(spongeService.fetchJobs).not.toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(0);
  });
});

describe('JobDataAuditCronService.run 护栏', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('开关默认关：不抢锁、不拉海绵', async () => {
    const { service, spongeService, redisService } = makeService({ NODE_ENV: 'production' });
    await service.run();
    expect(redisService.setNx).not.toHaveBeenCalled();
    expect(spongeService.fetchJobs).not.toHaveBeenCalled();
  });

  it('非生产环境不运行', async () => {
    const { service, spongeService, redisService } = makeService({
      NODE_ENV: 'development',
      JOB_DATA_AUDIT_ENABLED: 'true',
    });
    await service.run();
    expect(redisService.setNx).not.toHaveBeenCalled();
    expect(spongeService.fetchJobs).not.toHaveBeenCalled();
  });

  it('READ_ONLY_PREVIEW 跳过', async () => {
    const { service, spongeService } = makeService({ ...PROD_ENABLED, READ_ONLY_PREVIEW: 'true' });
    await service.run();
    expect(spongeService.fetchJobs).not.toHaveBeenCalled();
  });

  it('Redis 锁被占用时跳过；拿到锁则跑完后释放（含海绵抛错）', async () => {
    const { service, spongeService, redisService } = makeService(PROD_ENABLED);
    redisService.setNx.mockResolvedValueOnce(false);
    await service.run();
    expect(spongeService.fetchJobs).not.toHaveBeenCalled();
    expect(redisService.del).not.toHaveBeenCalled();

    redisService.setNx.mockResolvedValueOnce(true);
    spongeService.fetchJobs.mockRejectedValueOnce(new Error('海绵 502'));
    await expect(service.run()).resolves.toBeUndefined();
    expect(redisService.setNx).toHaveBeenLastCalledWith(
      JOB_DATA_AUDIT_LOCK_KEY,
      expect.any(String),
      1800,
    );
    expect(redisService.del).toHaveBeenCalledWith(JOB_DATA_AUDIT_LOCK_KEY);
  });

  it('RUNTIME_ENV=production 优先于 NODE_ENV', async () => {
    const { service, spongeService } = makeService({
      RUNTIME_ENV: 'production',
      NODE_ENV: 'development',
      JOB_DATA_AUDIT_ENABLED: 'true',
    });
    spongeService.fetchJobs.mockResolvedValue(page([], 0));
    await service.run();
    expect(spongeService.fetchJobs).toHaveBeenCalledTimes(1);
  });
});
