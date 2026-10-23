import { toErrorMessage, toErrorStack } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AlertLevel } from '@enums/alert.enum';
import { RedisLeaseService } from '@infra/queue/redis-lease.service';
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
import type { InvalidWorkTimeJob, JobDetail, JobListOptions } from '@sponge/sponge.types';

/**
 * 岗位数据体检 cron（PRD R4「数据体检告警」/ R8 防复发）。
 *
 * 每天一次拉全部在招岗位（六分区全开，分页有上限），跑 `auditJobDataBatch` 四类录入体检，
 * 汇总成**一条**飞书告警（按日期去重），正文只列岗位 ID / 品牌 / 问题，不列门店联系人。
 * 班次契约不合规的岗位由 SpongeService 按岗位剔除（invalidWorkTime=skip），计为「班次数据不合规」
 * 问题进同一份告警，不中断分页——本任务的职责正是发现这类坏数据。
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
/** 班次契约错误原文可能串联多处字段问题，告警单行只保留前段。 */
const WORK_TIME_DETAIL_MAX = 120;

export interface JobDataAuditRunResult {
  reportDate: string;
  /** 实际拉到并体检的岗位数（按 jobId 去重，含班次数据不合规而被剔除的岗位）。 */
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
    private readonly leases: RedisLeaseService,
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
    const lease = await this.leases.acquire(JOB_DATA_AUDIT_LOCK_KEY, LOCK_TTL_SECONDS);
    if (!lease) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('岗位数据体检失败', toErrorStack(error));
    } finally {
      this.running = false;
      await this.leases.release(lease);
    }
  }

  /** 执行一次体检（不含开关/锁护栏，便于测试与手动触发）。 */
  async runOnce(): Promise<JobDataAuditRunResult> {
    const reportDate = formatLocalDate(getLocalDayStart());
    const { jobs, invalidWorkTime, total, truncated, fetchError } = await this.fetchSignableJobs();
    const issues = [...invalidWorkTime.map(toWorkTimeIssue), ...auditJobDataBatch(jobs)];
    const byKind = countJobDataIssuesByKind(issues);
    const scanned = jobs.length + invalidWorkTime.length;
    const result: JobDataAuditRunResult = {
      reportDate,
      scanned,
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
      `岗位数据体检 ${reportDate}: 扫描 ${scanned}/${total} 岗${truncatedNote}，` +
        `问题 ${issues.length} 处${byKindText ? `（${byKindText}）` : ''}`,
    );
    // 没问题且拉取完整才静默；某页拉取失败也要出告警，否则「今天没问题」可能只是没拉到。
    if (issues.length === 0 && !truncated) return result;

    result.alerted = await this.alertNotifier.sendAlert({
      code: 'ops.job_data_audit',
      severity: AlertLevel.WARNING,
      summary:
        `岗位数据体检：${scanned} 个在招岗位发现 ${issues.length} 处录入问题` +
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
          scanned,
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
    invalidWorkTime: InvalidWorkTimeJob[];
    total: number;
    truncated: boolean;
    fetchError?: string;
  }> {
    const startedAt = Date.now();
    const jobs: JobDetail[] = [];
    const invalidWorkTime: InvalidWorkTimeJob[] = [];
    const seen = new Set<number>();
    const isNew = (jobId: number | null | undefined) => {
      if (typeof jobId !== 'number') return true;
      if (seen.has(jobId)) return false;
      seen.add(jobId);
      return true;
    };
    let total = Number.POSITIVE_INFINITY;
    let truncated = false;
    let fetchError: string | undefined;

    if (Date.now() - startedAt >= this.timeBudgetMs) {
      return { jobs, invalidWorkTime, total: 0, truncated: true };
    }
    let brandIds: number[];
    try {
      // 岗位接口要求明确查询范围；品牌目录来自同一供应商账号，不允许无筛选全量查询。
      const brands = await this.spongeService.fetchBrandList({ requireFresh: true });
      const validBrandIds = brands
        .map((brand) => brand.id)
        .filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0);
      if (validBrandIds.length !== brands.length) {
        throw new Error('品牌目录包含缺失或无效的品牌 ID，无法完成全量扫描');
      }
      if (validBrandIds.length === 0) throw new Error('未取得可查询的品牌目录');
      brandIds = [...new Set(validBrandIds)];
    } catch (error) {
      return {
        jobs,
        invalidWorkTime,
        total: 0,
        truncated: true,
        fetchError: `品牌范围读取失败: ${toErrorMessage(error)}`,
      };
    }

    const received = () => jobs.length + invalidWorkTime.length;
    for (let pageNum = 1; pageNum <= this.maxPages && received() < total; pageNum++) {
      if (Date.now() - startedAt >= this.timeBudgetMs) {
        truncated = true;
        break;
      }
      let page: Awaited<ReturnType<SpongeService['fetchJobs']>>;
      try {
        page = await this.spongeService.fetchJobs({
          brandIdList: brandIds,
          pageNum,
          pageSize: PAGE_SIZE,
          invalidWorkTime: 'skip',
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
        if (isNew(job.basicInfo?.jobId)) jobs.push(job);
      }
      const skipped = page.skippedInvalidWorkTime ?? [];
      for (const item of skipped) {
        if (isNew(item.jobId)) invalidWorkTime.push(item);
      }
      // 被剔除的岗位也占上游分页名额，满页判断须按上游实际返回条数。
      if (page.jobs.length + skipped.length < PAGE_SIZE) break;
      if (pageNum === this.maxPages && received() < total) truncated = true;
    }
    return {
      jobs,
      invalidWorkTime,
      total: Number.isFinite(total) ? total : received(),
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

function toWorkTimeIssue(item: InvalidWorkTimeJob): JobDataIssue {
  const detail =
    item.reason.length > WORK_TIME_DETAIL_MAX
      ? `${item.reason.slice(0, WORK_TIME_DETAIL_MAX)}…`
      : item.reason;
  return {
    jobId: item.jobId,
    brandName: item.brandName,
    kind: 'work_time_contract_invalid',
    detail,
  };
}
