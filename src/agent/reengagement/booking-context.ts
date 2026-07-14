import type { LongTermService } from '@memory/services/long-term.service';
import type { SpongeService } from '@sponge/sponge.service';
import type { JobDetail, SignupWorkOrderItem } from '@sponge/sponge.types';
import { buildJobPolicyAnalysis } from '@tools/utils/job-policy-parser';
import { parseInterviewTimestamp } from './scenario-registry';

export interface ReengagementBookingContext {
  workOrderId: number;
  jobId?: number;
  brandName?: string;
  companyName?: string;
  projectName?: string;
  storeName?: string;
  jobName?: string;
  currentStatus?: string;
  interviewAt?: number;
  interviewType?: string;
  interviewAddress?: string;
  interviewRequirement?: string;
  signUpTime?: string;
  interviewPassTime?: string;
  salary?: string;
}

export interface ResolveReengagementBookingContextInput {
  corpId: string;
  userId: string;
  preferredWorkOrderId?: number;
  botImId?: string;
}

/**
 * 复聊报名上下文统一解析：调用方已绑定 workOrderId 时直接查海绵，完全绕过 active_booking；
 * 只有普通对话未指定工单时，active_booking 才负责提供候选人的工单索引。海绵实时工单是
 * 唯一业务事实，岗位接口补面试方式/地址/要求；查询失败不使用本地快照或任务冻结值兜底。
 */
export async function resolveReengagementBookingContext(
  longTerm: LongTermService,
  sponge: SpongeService,
  input: ResolveReengagementBookingContextInput,
): Promise<ReengagementBookingContext | null> {
  let workOrderId = input.preferredWorkOrderId;
  if (workOrderId == null) {
    const activeBookings = await longTerm
      .getActiveBookings(input.corpId, input.userId)
      .catch(() => []);
    workOrderId = activeBookings[0]?.work_order_id;
  }

  let workOrder: SignupWorkOrderItem | null = null;
  if (workOrderId != null) {
    workOrder = await (
      input.botImId
        ? sponge.getWorkOrderById(workOrderId, { botImId: input.botImId })
        : sponge.getWorkOrderById(workOrderId)
    ).catch(() => null);
  }
  if (!workOrder || workOrderId == null) return null;

  const jobId = normalizePositiveInteger(workOrder.jobId);
  const job = jobId != null ? await loadJobDetail(sponge, jobId, input.botImId) : null;
  const jobPolicy = job ? buildJobPolicyAnalysis(job) : null;
  const storeInfo = asRecord(job?.basicInfo?.storeInfo);

  return compact({
    workOrderId,
    jobId,
    brandName: normalizeText(workOrder.brandName) ?? normalizeText(job?.basicInfo?.brandName),
    companyName: normalizeText(workOrder.companyName),
    projectName: normalizeText(workOrder.projectName),
    storeName: normalizeText(storeInfo?.storeName) ?? normalizeText(job?.basicInfo?.storeName),
    jobName: normalizeText(workOrder.jobName) ?? normalizeText(job?.basicInfo?.jobName),
    currentStatus: normalizeText(workOrder.currentStatus),
    interviewAt: parseInterviewTimestamp(workOrder.interviewTime) ?? undefined,
    interviewType: jobPolicy?.interviewMeta.method ?? undefined,
    interviewAddress: jobPolicy?.interviewMeta.address ?? undefined,
    interviewRequirement: jobPolicy?.interviewMeta.demand ?? undefined,
    signUpTime: normalizeText(workOrder.signUpTime),
    interviewPassTime: normalizeText(workOrder.interviewPassTime),
    salary: formatSalary(workOrder),
  });
}

async function loadJobDetail(
  sponge: SpongeService,
  jobId: number,
  botImId?: string,
): Promise<JobDetail | null> {
  try {
    const result = await sponge.fetchJobs(
      {
        jobIdList: [jobId],
        pageNum: 1,
        pageSize: 1,
        onlySignableJobs: false,
        options: { includeBasicInfo: true, includeInterviewProcess: true },
      },
      botImId ? { botImId } : undefined,
    );
    return result.jobs[0] ?? null;
  } catch {
    return null;
  }
}

function formatSalary(workOrder: SignupWorkOrderItem | null): string | undefined {
  if (workOrder?.salary == null) return undefined;
  return [String(workOrder.salary), workOrder.salaryUnit, workOrder.salaryPeriod]
    .map(normalizeText)
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
