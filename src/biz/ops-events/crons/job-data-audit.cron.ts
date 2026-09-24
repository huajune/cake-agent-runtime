import { toErrorMessage, toErrorStack } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AlertLevel } from '@enums/alert.enum';
import { RedisService } from '@infra/redis/redis.service';
import { formatLocalDate, getLocalDayStart } from '@infra/utils/date.util';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import {
  auditJobDataBatch,
  countJobDataIssuesByKind,
  formatJobDataAuditReport,
  JOB_DATA_ISSUE_LABELS,
  type JobDataIssue,
  type JobDataIssueKind,
} from '@sponge/job-data-audit.util';
import { SpongeService } from '@sponge/sponge.service';
import type { JobDetail, JobListOptions } from '@sponge/sponge.types';

/**
 * 岗位数据体检 cron（PRD R4「数据体检告警」/ R8 防复发）。
 *
 * 每天一次拉全部在招岗位（六分区全开，分页有上限），跑 `auditJobDataBatch` 四类录入体检，
 * 汇总成**一条**飞书告警（按日期去重），正文只列岗位 ID / 品牌 / 问题，不列门店联系人。
 *
 * 护栏：
 * - 只在生产运行（RUNTIME_ENV / NODE_ENV = production），READ_ONLY_PREVIEW 跳过；
 * - 运行时开关 JOB_DATA_AUDIT_ENABLED 默认关；
 * - Redis SET NX 整轮互斥（多实例只跑一份），进程内 running 标志防重入；
 * - 分页上限 JOB_DATA_AUDIT_MAX_PAGES × 50 条，硬时间窗 JOB_DATA_AUDIT_TIME_BUDGET_MS，
 *   超限即带「已截断」标记出告警，不重试、不回退更重的查询。
 */
const ALL_SECTIONS: JobListOptions = {
  includeBasicInfo: true,
  includeJobSalary: true,
  includeWelfare: true,
  includeHiringRequirement: true,
  includeWorkTime: true,
  includeInterviewProcess: true,
};

export const JOB_DATA_AUDIT_LOCK_KEY = 'ops:job-data-audit:lock';
const LOCK_TTL_SECONDS = 30 * 60;
const PAGE_SIZE = 50;
const REPORT_MAX_LINES = 60;

export interface JobDataAuditRunResult {
  reportDate: string;
  /** 实际拉到并体检的岗位数（按 jobId 去重）。 */
  scanned: number;
  /** 海绵报告的在招岗位总数。 */
  total: number;
  /** 分页上限、时间窗触顶或某页拉取失败，只扫了一部分。 */
  truncated: boolean;
  /** 某页 fetchJobs 抛错时的说明（页码 + 错误），整轮不中断，只体检已拉到的页。 */
  fetchError?: string;
  issues: JobDataIssue[];
  byKind: Record<JobDataIssueKind, number>;
  alerted: boolean;
}

@Injectable()
export class JobDataAuditCronService {
  private readonly logger = new Logger(JobDataAuditCronService.name);
  private readonly enabled: boolean;
  private readonly maxPages: number;
  private readonly timeBudgetMs: number;
  private running = false;

  constructor(
    private readonly spongeService: SpongeService,
    private readonly alertNotifier: AlertNotifierService,
    private readonly redisService: RedisService,
    @Optional() private readonly configService?: ConfigService,
  ) {
    this.enabled = this.configService?.get<string>('JOB_DATA_AUDIT_ENABLED', 'false') === 'true';
    this.maxPages = Number.parseInt(
      this.configService?.get<string>('JOB_DATA_AUDIT_MAX_PAGES', '20') ?? '20',
      10,
    );
    this.timeBudgetMs = Number.parseInt(
      this.configService?.get<string>('JOB_DATA_AUDIT_TIME_BUDGET_MS', '300000') ?? '300000',
      10,
    );
  }

  /** 每天 08:30 Asia/Shanghai（运营上班前，告警当天可处理）。 */
  @Cron('30 8 * * *', { timeZone: 'Asia/Shanghai' })
  async run(): Promise<void> {
    if (this.isReadOnlyPreview()) return;
    if (!this.enabled) {
      this.logger.debug('岗位数据体检未开启（JOB_DATA_AUDIT_ENABLED≠true），跳过');
      return;
    }
    if (!this.isProduction()) {
      this.logger.debug('岗位数据体检只在生产运行，跳过');
      return;
    }
    if (this.running) {
      this.logger.warn('上一轮岗位数据体检尚未结束，跳过本次');
      return;
    }
    const locked = await this.redisService
      .setNx(JOB_DATA_AUDIT_LOCK_KEY, new Date().toISOString(), LOCK_TTL_SECONDS)
      .catch((error: unknown) => {
        this.logger.warn(`岗位数据体检抢锁失败，跳过本次: ${toErrorMessage(error)}`);
        return false;
      });
    if (!locked) {
      this.logger.warn('岗位数据体检已有实例在跑（Redis 锁占用），跳过本次');
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('岗位数据体检失败', toErrorStack(error));
    } finally {
      this.running = false;
      await this.redisService.del(JOB_DATA_AUDIT_LOCK_KEY).catch((error: unknown) => {
        this.logger.warn(`岗位数据体检释放锁失败（TTL 到期自动释放）: ${toErrorMessage(error)}`);
      });
    }
  }

  /** 执行一次体检（不含开关/锁护栏，便于测试与手动触发）。 */
  async runOnce(): Promise<JobDataAuditRunResult> {
    const reportDate = formatLocalDate(getLocalDayStart());
    const { jobs, total, truncated, fetchError } = await this.fetchSignableJobs();
    const issues = auditJobDataBatch(jobs);
    const byKind = countJobDataIssuesByKind(issues);
    const result: JobDataAuditRunResult = {
      reportDate,
      scanned: jobs.length,
      total,
      truncated,
      ...(fetchError ? { fetchError } : {}),
      issues,
      byKind,
      alerted: false,
    };
    const truncatedNote = fetchError
      ? `，拉取被截断（${fetchError}）`
      : truncated
        ? '，扫描已截断'
        : '';

    const byKindText = (Object.keys(byKind) as JobDataIssueKind[])
      .filter((kind) => byKind[kind] > 0)
      .map((kind) => `${JOB_DATA_ISSUE_LABELS[kind]} ${byKind[kind]}`)
      .join('，');
    this.logger.log(
      `岗位数据体检 ${reportDate}: 扫描 ${jobs.length}/${total} 岗${truncatedNote}，` +
        `问题 ${issues.length} 处${byKindText ? `（${byKindText}）` : ''}`,
    );
    // 没问题且拉取完整才静默；某页拉取失败也要出告警，否则「今天没问题」可能只是没拉到。
    if (issues.length === 0 && !fetchError) return result;

    result.alerted = await this.alertNotifier.sendAlert({
      code: 'ops.job_data_audit',
      severity: AlertLevel.WARNING,
      summary:
        `岗位数据体检：${jobs.length} 个在招岗位发现 ${issues.length} 处录入问题` +
        `${byKindText ? `（${byKindText}）` : ''}${truncatedNote}`,
      source: {
        subsystem: 'ops-events',
        component: 'job-data-audit',
        action: 'daily_check',
        trigger: 'cron',
      },
      diagnostics: {
        category: 'job_data_audit',
        payload: {
          reportDate,
          scanned: jobs.length,
          total,
          truncated,
          ...(fetchError ? { fetchError } : {}),
          byKind,
          report: formatJobDataAuditReport(issues, REPORT_MAX_LINES),
        },
      },
      dedupe: { key: `ops.job_data_audit:${reportDate}` },
    });
    return result;
  }

  private async fetchSignableJobs(): Promise<{
    jobs: JobDetail[];
    total: number;
    truncated: boolean;
    fetchError?: string;
  }> {
    const startedAt = Date.now();
    const jobs: JobDetail[] = [];
    const seen = new Set<number>();
    let total = Number.POSITIVE_INFINITY;
    let truncated = false;
    let fetchError: string | undefined;

    for (let pageNum = 1; pageNum <= this.maxPages && jobs.length < total; pageNum++) {
      if (Date.now() - startedAt >= this.timeBudgetMs) {
        truncated = true;
        break;
      }
      let page: Awaited<ReturnType<SpongeService['fetchJobs']>>;
      try {
        page = await this.spongeService.fetchJobs({
          pageNum,
          pageSize: PAGE_SIZE,
          options: ALL_SECTIONS,
        });
      } catch (error) {
        // 某页失败不中断整轮：已拉到的页照常体检，结果标记截断并在告警里说明，不重试、不回退更重的查询。
        fetchError = `第 ${pageNum} 页拉取失败: ${toErrorMessage(error)}`;
        truncated = true;
        this.logger.warn(`岗位数据体检${fetchError}，已拉 ${jobs.length} 岗继续体检`);
        break;
      }
      total = page.total;
      for (const job of page.jobs) {
        const jobId = job.basicInfo?.jobId;
        if (typeof jobId === 'number') {
          if (seen.has(jobId)) continue;
          seen.add(jobId);
        }
        jobs.push(job);
      }
      if (page.jobs.length < PAGE_SIZE) break;
      if (pageNum === this.maxPages && jobs.length < total) truncated = true;
    }
    return {
      jobs,
      total: Number.isFinite(total) ? total : jobs.length,
      truncated,
      ...(fetchError ? { fetchError } : {}),
    };
  }

  private isReadOnlyPreview(): boolean {
    return this.configService?.get<string>('READ_ONLY_PREVIEW', 'false') === 'true';
  }

  private isProduction(): boolean {
    const runtimeEnv =
      this.configService?.get<string>('RUNTIME_ENV') ||
      this.configService?.get<string>('NODE_ENV') ||
      'development';
    return runtimeEnv === 'production';
  }
}
