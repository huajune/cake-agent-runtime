import { Injectable } from '@nestjs/common';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type { TurnLedger } from '@shared-types/turn.types';
import type {
  BookingEvidence,
  GeocodeEvidence,
  GroupInviteEvidence,
  GuardrailReviewPacket,
  JobListEvidence,
  JobListEvidenceItem,
  PrecheckEvidence,
} from './review-packet.types';

export interface BuildReviewPacketInput {
  reply: string;
  toolCalls: AgentToolCall[];
  turnLedger?: Pick<TurnLedger, 'visualFactSheets'>;
  userMessage?: string;
  /** 短期记忆里的往轮助手文本（正序）。缺省为空——repair 等旁路调用方无需提供。 */
  recentAssistantTexts?: string[];
  redLines?: string[];
  outputRuleHits?: string[];
}

// 往轮助手消息进 packet 的预算：条数取最近 8 条覆盖常见"查岗→展示→追问"链，
// 单条 600 字符足够容纳一条多门店推荐卡片；再长的尾部对复述判定无增量，只烧 token。
const RECENT_ASSISTANT_MESSAGES_LIMIT = 8;
const RECENT_ASSISTANT_MESSAGE_MAX_CHARS = 600;
const VISUAL_SHEETS_LIMIT = 4;
const VISUAL_DESCRIPTION_MAX_CHARS = 400;

@Injectable()
export class GuardrailReviewPacketBuilder {
  build(input: BuildReviewPacketInput): GuardrailReviewPacket {
    return {
      draftReply: input.reply,
      latestUserMessages: input.userMessage
        ? [{ role: 'user', content: input.userMessage, messageType: 'text' }]
        : [],
      recentAssistantMessages: this.buildRecentAssistantMessages(input.recentAssistantTexts),
      evidence: {
        jobList: this.buildJobListEvidence(input.toolCalls),
        precheck: this.buildPrecheckEvidence(input.toolCalls),
        booking: this.buildBookingEvidence(input.toolCalls),
        geocode: this.buildGeocodeEvidence(input.toolCalls),
        sentLocation: this.buildSentLocationEvidence(input.toolCalls),
        groupInvite: this.buildGroupInviteEvidence(input.toolCalls),
        visualFacts: this.buildVisualFactsEvidence(input.turnLedger?.visualFactSheets ?? []),
      },
      policies: {
        redLines: input.redLines ?? [],
        outputRuleHits: input.outputRuleHits ?? [],
      },
    };
  }

  /** 裁剪往轮助手文本：去空白条、保留最近 N 条、单条超预算截尾（复述核验只需前段的事实主体）。 */
  private buildRecentAssistantMessages(texts?: string[]): string[] {
    if (!texts?.length) return [];
    return texts
      .filter((text) => text.trim().length > 0)
      .slice(-RECENT_ASSISTANT_MESSAGES_LIMIT)
      .map((text) =>
        text.length > RECENT_ASSISTANT_MESSAGE_MAX_CHARS
          ? `${text.slice(0, RECENT_ASSISTANT_MESSAGE_MAX_CHARS)}…`
          : text,
      );
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

  /**
   * 群邀请证据（2026-08-04 审计 P1-6）：invite_to_group 的下发结果。缺了它，
   * `fact_asserted_without_any_evidence` 会把当轮 invite:ok 支撑的"群邀请已经发你了"
   * 判成零证据编造（trace …_1785451709779 硬假阳）。
   */
  private buildGroupInviteEvidence(toolCalls: AgentToolCall[]): GroupInviteEvidence | undefined {
    const call = [...toolCalls]
      .reverse()
      .find((item) => item.toolName === 'invite_to_group' && item.result);
    const result = readRecord(call?.result);
    if (!result) return undefined;

    return {
      success: result.success === true,
      groupName: readString(result.groupName),
      alreadyInGroup: readBoolean(result.alreadyInGroup),
      errorType: readString(result.errorType),
    };
  }

  /**
   * 视觉事实证据直接读回合账本；不再从 save_image_description 参数重建第二份事实。
   */
  private buildVisualFactsEvidence(
    visualFactSheets: TurnLedger['visualFactSheets'],
  ): GuardrailReviewPacket['evidence']['visualFacts'] {
    const sheets = visualFactSheets
      .slice(0, VISUAL_SHEETS_LIMIT)
      .map(({ sheet }) => {
        const finalizedDescription = sheet.rawDescription;
        return {
          kind: sheet.kind,
          description:
            finalizedDescription && finalizedDescription.length > VISUAL_DESCRIPTION_MAX_CHARS
              ? `${finalizedDescription.slice(0, VISUAL_DESCRIPTION_MAX_CHARS)}…`
              : finalizedDescription || undefined,
          fields: sheet.fields,
        };
      })
      .filter((sheet) => sheet.fields.length > 0 || sheet.description);
    return sheets.length > 0 ? { sheets } : undefined;
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
/** 薪资补录上限：单岗薪资段实测 300-600 字，8 岗以内的主流形态兜得住。 */
const SALARY_APPENDIX_MAX_CHARS = 2400;
const JOB_DETAIL_HEADING_PATTERN = /^## \d+\.\s.*$/gm;
const SALARY_SECTION_HEADING = '### 薪资信息';

function readMarkdownExcerpt(result: unknown): string | undefined {
  const record = readRecord(result);
  const markdown = readString(record?.markdown);
  if (!markdown) return undefined;
  if (markdown.length <= MARKDOWN_EXCERPT_MAX_CHARS) return markdown;
  const excerpt = `${markdown.slice(0, MARKDOWN_EXCERPT_MAX_CHARS)}\n…（岗位详情已截断）`;
  const appendix = buildTruncatedSalaryAppendix(markdown, MARKDOWN_EXCERPT_MAX_CHARS);
  return appendix ? `${excerpt}\n\n${appendix}` : excerpt;
}

/**
 * 2026-08-04 badcase（trace batch_6a719fde…_1785831840599）：markdown 全长 7372，
 * 达美乐详情段起于 5380、「基础薪资: 13.8 元/时」在 6379——4000 字截断后 reviewer
 * 只剩顶部卡片的「0-110 元/天」（卡片综合薪资优先、从不显示 basicSalary），
 * 把模型正确投递的时薪判成编造并要求改写。截断时把被截岗位的「薪资信息」段
 * 原文补录回证据，薪资 ground truth 不再取决于岗位排在 markdown 的第几位。
 */
function buildTruncatedSalaryAppendix(markdown: string, cutoff: number): string | undefined {
  const headings = [...markdown.matchAll(JOB_DETAIL_HEADING_PATTERN)];
  const blocks: string[] = [];
  headings.forEach((heading, index) => {
    const sectionStart = heading.index;
    if (sectionStart === undefined) return;
    const sectionEnd = headings[index + 1]?.index ?? markdown.length;
    const salaryStart = markdown.indexOf(SALARY_SECTION_HEADING, sectionStart);
    if (salaryStart < 0 || salaryStart >= sectionEnd) return;
    const salaryEnd = findSalarySectionEnd(
      markdown,
      salaryStart + SALARY_SECTION_HEADING.length,
      sectionEnd,
    );
    // 薪资段完整落在摘录窗口内的岗位无须补录；被截断（哪怕只截了后半）就整段补。
    if (salaryEnd <= cutoff) return;
    blocks.push(`${heading[0]}\n${markdown.slice(salaryStart, salaryEnd).trimEnd()}`);
  });
  if (blocks.length === 0) return undefined;
  const body = blocks.join('\n');
  const capped =
    body.length > SALARY_APPENDIX_MAX_CHARS
      ? `${body.slice(0, SALARY_APPENDIX_MAX_CHARS)}\n…（薪资补录已截断）`
      : body;
  return `【截断补录·岗位薪资信息】以下岗位的详情段被上方截断，其薪资字段以本补录为准：\n${capped}`;
}

function findSalarySectionEnd(markdown: string, from: number, sectionEnd: number): number {
  const boundaries = [markdown.indexOf('\n### ', from), markdown.indexOf('\n---', from)].filter(
    (idx) => idx >= 0 && idx < sectionEnd,
  );
  return boundaries.length > 0 ? Math.min(...boundaries) : sectionEnd;
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
