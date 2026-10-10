import type { JobDetail, JobListResult, JobListQueryParams } from '@sponge/sponge.types';
import { WorkTimeContractError } from '@sponge/work-time.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';

export interface JobScanMeta {
  upstreamTotal: number;
  scannedCount: number;
  scannedPages: number;
  scanComplete: boolean;
  stopReason:
    | 'complete'
    | 'page_limit'
    | 'time_budget'
    | 'empty_page'
    | 'duplicate_page'
    | 'page_error'
    | 'total_changed'
    | 'not_scanned';
}

export const JOB_SCAN_BUDGET_MS = 15_000;
export const JOB_SCAN_PAGE_SIZE = 20;
export const JOB_SCAN_MAX_PAGES = 10;

/** 在同一查询条件下有界补页。异常数据不能跳过；网络或预算中断只说明未查完。 */
export async function scanJobPages(
  first: JobListResult,
  params: JobListQueryParams,
  fetchPage: (params: JobListQueryParams, signal: AbortSignal) => Promise<JobListResult>,
  deadline: number,
): Promise<{ jobs: JobDetail[]; meta: JobScanMeta }> {
  const jobs: JobDetail[] = [];
  const ids = new Set<number>();
  const append = (page: JobDetail[]) => {
    for (const job of page) {
      const id = job.basicInfo?.jobId;
      if (typeof id !== 'number') throw new Error('岗位缺少有效jobId，无法确定分页唯一性');
      if (!ids.has(id)) {
        ids.add(id);
        jobs.push(job);
      }
    }
  };
  append(first.jobs);
  const meta: JobScanMeta = {
    upstreamTotal: first.total,
    scannedCount: jobs.length,
    scannedPages: 1,
    scanComplete: jobs.length >= first.total,
    stopReason: 'complete',
  };
  let totalChanged = false;
  while (jobs.length < meta.upstreamTotal) {
    if (meta.scannedPages >= JOB_SCAN_MAX_PAGES) {
      meta.stopReason = 'page_limit';
      break;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      meta.stopReason = 'time_budget';
      break;
    }
    let page: JobListResult;
    try {
      page = await fetchPage(
        { ...params, pageNum: meta.scannedPages + 1, pageSize: JOB_SCAN_PAGE_SIZE },
        AbortSignal.timeout(remaining),
      );
    } catch (error) {
      if (error instanceof WorkTimeContractError) throw error;
      meta.stopReason = Date.now() >= deadline ? 'time_budget' : 'page_error';
      break;
    }
    meta.scannedPages++;
    totalChanged ||= page.total !== first.total;
    meta.upstreamTotal = Math.max(meta.upstreamTotal, page.total);
    if (!page.jobs.length) {
      meta.stopReason = 'empty_page';
      break;
    }
    const before = jobs.length;
    append(page.jobs);
    if (before === jobs.length) {
      meta.stopReason = 'duplicate_page';
      break;
    }
  }
  meta.scannedCount = jobs.length;
  meta.scanComplete = jobs.length >= meta.upstreamTotal && !totalChanged;
  if (totalChanged && meta.stopReason === 'complete') meta.stopReason = 'total_changed';
  return { jobs, meta };
}

/** 所有本地过滤的空结果共享完整性口径，不能把截断或待确认伪装成无岗。 */
export function buildScannedQueryError(
  args: Parameters<typeof buildToolError>[0],
  scan: JobScanMeta | undefined,
  unknown: Array<{ jobId: number | null; reason: string }>,
) {
  const emptyTypes: string[] = [
    TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS,
    TOOL_ERROR_TYPES.JOB_LIST_SCHEDULE_FILTER_EMPTY,
    TOOL_ERROR_TYPES.JOB_LIST_LABOR_FORM_FILTER_EMPTY,
    TOOL_ERROR_TYPES.JOB_LIST_STUDENT_FILTER_EMPTY,
  ];
  const incomplete =
    scan && (!scan.scanComplete || unknown.length > 0) && emptyTypes.includes(args.errorType);
  const details = { ...args.details };
  if (incomplete) delete details.noMatchScript;
  const priorMeta =
    details.queryMeta && typeof details.queryMeta === 'object' ? details.queryMeta : {};
  return buildToolError({
    ...args,
    ...(incomplete
      ? {
          errorType: TOOL_ERROR_TYPES.JOB_LIST_QUERY_INCOMPLETE,
          outcome: '已查询范围内尚未确认可推荐岗位',
          replyInstruction:
            '目前只在已查询范围内未确认可推荐岗位，查询未完整或仍有班次待确认。不能断言全城/全范围无岗，不能放宽候选人条件或推荐待确认岗位；说明仍需核对即可。',
        }
      : {}),
    details: {
      ...details,
      queryMeta: { ...priorMeta, ...scan, unknownCount: unknown.length, unknownSchedules: unknown },
    },
  });
}
