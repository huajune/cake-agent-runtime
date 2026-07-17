import { Injectable } from '@nestjs/common';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type {
  BookingEvidence,
  GeocodeEvidence,
  GuardrailReviewPacket,
  JobListEvidence,
  JobListEvidenceItem,
  PrecheckEvidence,
} from './review-packet.types';

export interface BuildReviewPacketInput {
  reply: string;
  toolCalls: AgentToolCall[];
  userMessage?: string;
  redLines?: string[];
  outputRuleHits?: string[];
}

@Injectable()
export class GuardrailReviewPacketBuilder {
  build(input: BuildReviewPacketInput): GuardrailReviewPacket {
    return {
      draftReply: input.reply,
      latestUserMessages: input.userMessage
        ? [{ role: 'user', content: input.userMessage, messageType: 'text' }]
        : [],
      evidence: {
        jobList: this.buildJobListEvidence(input.toolCalls),
        precheck: this.buildPrecheckEvidence(input.toolCalls),
        booking: this.buildBookingEvidence(input.toolCalls),
        geocode: this.buildGeocodeEvidence(input.toolCalls),
        sentLocation: this.buildSentLocationEvidence(input.toolCalls),
      },
      policies: {
        redLines: input.redLines ?? [],
        outputRuleHits: input.outputRuleHits ?? [],
      },
    };
  }

  private buildJobListEvidence(toolCalls: AgentToolCall[]): JobListEvidence | undefined {
    const jobListCalls = toolCalls.filter(
      (item) => item.toolName === 'duliday_job_list' && item.result,
    );
    if (jobListCalls.length === 0) return undefined;

    // 优先取最后一次"可用"结果：Agent 常见动作链是"近查空→扩面有果→复核空"，
    // 岗位事实接地在中间那次；只看最后一次会让 reviewer 拿到空证据误判未接地
    // （与 rule 档 2026-07-06 修复同口径）。全空时保留最后一次，让 reviewer 看到空态。
    const usable = [...jobListCalls]
      .reverse()
      .find((item) => item.resultCount !== 0 && item.status !== 'error' && item.status !== 'empty');
    const call = usable ?? jobListCalls[jobListCalls.length - 1];

    // §11 第三切换点：品牌意图改读工具入口标准化后的 queryMeta.brand，
    // 并按 filterMode 区分正向查询与排除。exclude 的 appliedCanonicalNames 是
    // 候选人拒绝的品牌，绝不能放进 requestedBrands 误导 reviewer。
    const brandMeta = readBrandQueryMeta(call.result);
    const appliedBrands = brandMeta?.appliedCanonicalNames ?? [];
    const isExcludeMode = brandMeta?.filterMode === 'exclude';
    const requestedBrands = isExcludeMode ? [] : appliedBrands;
    const excludedBrands = isExcludeMode ? appliedBrands : [];
    const rejectedBrandInputs = brandMeta?.rejectedInputs ?? [];
    const jobs = readJobListJobs(call.result)
      .slice(0, 8)
      .map((job) => this.toJobEvidenceItem(job));
    const markdownExcerpt = jobs.length === 0 ? readMarkdownExcerpt(call.result) : undefined;
    return {
      args: pickJobListQueryIntent(call.args),
      resultCount: call.resultCount,
      status: call.status,
      hasEvidence: jobs.length > 0 || Boolean(markdownExcerpt),
      requestedBrands,
      ...(excludedBrands.length > 0 ? { excludedBrands } : {}),
      ...(rejectedBrandInputs.length > 0 ? { rejectedBrandInputs } : {}),
      jobs,
      // 默认返回形态是 markdown-only（无 rawData 数组）：结构化解析为空时，
      // markdown 摘录就是岗位事实的唯一 ground truth。
      markdownExcerpt,
      markdownExcerptChars: markdownExcerpt?.length,
    };
  }

  private toJobEvidenceItem(job: unknown): JobListEvidenceItem {
    const record = readRecord(job) ?? {};
    const basicInfo = readRecord(record.basicInfo);
    const storeInfo = readRecord(basicInfo?.storeInfo);
    const brandInfo = readRecord(basicInfo?.brandInfo);
    return {
      jobId: readString(record.jobId) ?? readNumber(record.jobId),
      brandName:
        readString(record.brandName) ??
        readString(basicInfo?.brandName) ??
        readString(brandInfo?.brandName),
      storeName:
        readString(record.storeName) ??
        readString(basicInfo?.storeName) ??
        readString(storeInfo?.storeName),
      distanceKm: readDistanceKm(record),
      jobSalary: stringifyCompact(record.jobSalary ?? basicInfo?.jobSalary),
      scheduleText:
        readString(record.scheduleText) ??
        readString(record.workTime) ??
        readString(basicInfo?.workTime) ??
        stringifyCompact(record.shiftTimeList ?? record.workTimeList),
      address:
        readString(record.address) ??
        readString(record.storeAddress) ??
        readString(storeInfo?.address) ??
        readString(storeInfo?.storeAddress),
    };
  }

  private buildPrecheckEvidence(toolCalls: AgentToolCall[]): PrecheckEvidence | undefined {
    const call = [...toolCalls]
      .reverse()
      .find((item) => item.toolName === 'duliday_interview_precheck' && item.result);
    const result = readRecord(call?.result);
    if (!result) return undefined;

    const checklist = readRecord(result.bookingChecklist);
    const strategy = readRecord(checklist?.collectionStrategy);
    const interview = readRecord(result.interview);
    const ageBoundary = readRecord(result.ageBoundary);
    const nameFieldGuard = readRecord(result.nameFieldGuard);
    return {
      nextAction: readString(result.nextAction),
      requiredFieldsToCollectNow: readStringArray(checklist?.requiredFieldsToCollectNow),
      starterFields: readStringArray(strategy?.starterFields),
      missingFields: readStringArray(checklist?.missingFields),
      interviewTimeMode:
        readString(interview?.interviewTimeMode) ?? readString(result.interviewTimeMode),
      blockedReason:
        readString(result.blockedReason) ??
        readString(ageBoundary?.reason) ??
        readString(nameFieldGuard?.reason),
    };
  }

  private buildBookingEvidence(toolCalls: AgentToolCall[]): BookingEvidence | undefined {
    const call = [...toolCalls]
      .reverse()
      .find((item) => item.toolName === 'duliday_interview_booking' && item.result);
    const result = readRecord(call?.result);
    if (!result) return undefined;

    return {
      success: result.success === true || result.workOrderId != null,
      status: readString(result.status),
      errorType: readString(result.errorType),
      confirmedInterviewTimeHuman: readString(result._confirmedInterviewTimeHuman),
      onSiteScript: readString(result._onSiteScript),
      interviewAddress:
        readString(result.interviewAddress) ??
        readString(result._interviewAddress) ??
        readString(result.address),
      interviewMode:
        readString(result.interviewMode) ??
        readString(result._interviewMode) ??
        readString(result.interviewType),
    };
  }

  private buildGeocodeEvidence(toolCalls: AgentToolCall[]): GeocodeEvidence | undefined {
    const call = [...toolCalls]
      .reverse()
      .find((item) => item.toolName === 'geocode' && item.result);
    const outer = readRecord(call?.result);
    if (!outer) return undefined;

    // 线上 geocode 工具常见形态：
    // { result: { latitude, longitude, formattedAddress, areaLevelQuery }, resolution: 'unique' }。
    // candidates 为空不等于解析失败；有坐标就是有效解析。
    const result = readRecord(outer.result) ?? outer;
    const candidateRecords = readArray(
      outer.candidates ??
        outer.candidateAddresses ??
        result.candidates ??
        result.candidateAddresses,
    );
    const latitude = readNumber(result.latitude);
    const longitude = readNumber(result.longitude);
    return {
      resolution: readString(outer.resolution) ?? readString(result.resolution),
      errorType: readString(outer.errorType) ?? readString(result.errorType),
      confidence:
        readString(outer.confidence) ??
        readNumber(outer.confidence) ??
        readString(result.confidence) ??
        readNumber(result.confidence),
      formattedAddress: readString(result.formattedAddress) ?? readString(outer.formattedAddress),
      latitude,
      longitude,
      areaLevelQuery: readBoolean(result.areaLevelQuery) ?? readBoolean(outer.areaLevelQuery),
      hasResolvedCoordinate: latitude != null && longitude != null,
      candidates: candidateRecords
        .map((candidate) => {
          const record = readRecord(candidate);
          return (
            readString(record?.formattedAddress) ??
            readString(record?.address) ??
            readString(record?.name) ??
            readString(candidate)
          );
        })
        .filter((value): value is string => Boolean(value))
        .slice(0, 5),
    };
  }

  private buildSentLocationEvidence(
    toolCalls: AgentToolCall[],
  ): GuardrailReviewPacket['evidence']['sentLocation'] {
    const call = [...toolCalls]
      .reverse()
      .find((item) => item.toolName === 'send_store_location' && item.result);
    const result = readRecord(call?.result);
    if (!result) return undefined;
    const destination = readString(result.destination);
    return {
      success: result.success === true,
      destination: destination === 'interview' || destination === 'store' ? destination : undefined,
      interviewMethod: readString(result.interviewMethod),
      locationNotRequired: readBoolean(result.locationNotRequired),
      storeName: readString(result.storeName),
      storeAddress: readString(result.storeAddress),
      interviewAddress: readString(result.interviewAddress),
      sentAddress: readString(result.sentAddress),
      addressConflict: readBoolean(result.addressConflict),
      errorType: readString(result.errorType),
    };
  }
}

/** reviewer 对账"候选人要的 vs 推荐的"所需的查询意图字段；分页/半径等执行参数不进证据包。 */
const JOB_LIST_QUERY_INTENT_KEYS = [
  'cityNameList',
  'regionNameList',
  'brandAliasList',
  'brandIdList',
  'brandFilterMode',
  'storeNameList',
  'searchJobName',
  'jobCategoryList',
  'settlementPeriodList',
  'jobIdList',
] as const;

function pickJobListQueryIntent(args: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of JOB_LIST_QUERY_INTENT_KEYS) {
    const value = args[key];
    if (value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    picked[key] = value;
  }
  // 坐标本身对 reviewer 无意义，但"是否按距离召回"影响 job_recommendation 对账。
  if (readRecord(args.location)) picked.locationBasedRecall = true;
  return picked;
}

function readJobListJobs(result: unknown): unknown[] {
  const record = readRecord(result);
  const rawData = readRecord(record?.rawData);
  const jobs = rawData?.result ?? record?.result ?? record?.jobs ?? record?.items;
  return Array.isArray(jobs) ? jobs : [];
}

/** 读取工具结果里的 queryMeta.brand 小节（成功与错误结果同一路径）。 */
function readBrandQueryMeta(
  result: unknown,
): { filterMode?: string; appliedCanonicalNames: string[]; rejectedInputs: string[] } | null {
  const record = readRecord(result);
  const queryMeta = readRecord(record?.queryMeta);
  const brand = readRecord(queryMeta?.brand);
  if (!brand) return null;
  const rejected = readArray(brand.rejected)
    .map((item) => readString(readRecord(item)?.input))
    .filter((input): input is string => Boolean(input));
  return {
    filterMode: readString(brand.filterMode),
    appliedCanonicalNames: readStringArray(brand.appliedCanonicalNames),
    rejectedInputs: rejected,
  };
}

/** markdown 证据摘录上限：开头的岗位卡片汇总区（推荐对话用模板）通常在前 4000 字内。 */
const MARKDOWN_EXCERPT_MAX_CHARS = 4000;

function readMarkdownExcerpt(result: unknown): string | undefined {
  const record = readRecord(result);
  const markdown = readString(record?.markdown);
  if (!markdown) return undefined;
  return markdown.length > MARKDOWN_EXCERPT_MAX_CHARS
    ? `${markdown.slice(0, MARKDOWN_EXCERPT_MAX_CHARS)}\n…（岗位详情已截断）`
    : markdown;
}

function readDistanceKm(record: Record<string, unknown>): number | undefined {
  const direct = readNumber(record.distanceKm) ?? readNumber(record._distanceKm);
  if (direct != null) return direct;
  const distance = readNumber(record.distance);
  if (distance == null) return undefined;
  return distance > 100 ? distance / 1000 : distance;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((item): item is string => Boolean(item))
    : [];
}

function stringifyCompact(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  try {
    const text = JSON.stringify(value);
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    return undefined;
  }
}
