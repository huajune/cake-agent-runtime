/**
 * DuLiDay 面试预约工具
 *
 * 为求职者预约面试，需要提供与海绵 supplier/entryUser 契约一致的字段。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import type { InterviewBookingCustomerLabel, JobDetail } from '@sponge/sponge.types';
import {
  getSpongeGenderLabelById,
  SPONGE_EDUCATION_MAPPING,
  SPONGE_GENDER_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING,
  SPONGE_OPERATE_TYPE_MAPPING,
} from '@sponge/sponge.enums';
import {
  extractInterviewSupplementDefinitions,
  type SpongeInterviewSupplementDefinition,
} from '@sponge/sponge-job.util';
import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import { findLatestExplicitIdentityEvidence } from '@resolution/candidate/student-identity';
import { stripTimeContextSuffix } from '@resolution/candidate/name';
import { stripQuotedBlocks } from '@resolution/signal/markers';
import { isTestPiiPhoneAllowed, maskPhoneForDetails } from '@tools/shared/test-pii-gate';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import { LongTermService } from '@memory/services/long-term.service';
import type { ActiveBookingEntry } from '@memory/types/long-term.types';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { ToolBuildContext, ToolBuilder } from '@shared-types/tool.types';
import { API_BOOKING_REQUIRED_PAYLOAD_FIELDS } from '@tools/duliday/booking/job-booking.contract';
import { buildCustomerLabelList } from '@tools/duliday/booking/interview-booking-customer-label.builder';
import { runBookingGuards } from '@tools/duliday/booking/booking-guards.util';
import {
  buildOnSiteScript,
  isOnlineInterview,
  formatInterviewTimeForReply,
  resolveManualInterviewGroupHandling,
  type ManualInterviewGroupHandling,
} from '@tools/duliday/booking/booking-reply-format.util';
import { buildJobPolicyAnalysis, isWaitNoticeInterview } from '@tools/utils/job-policy-parser';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { countRealNameAsks } from '@resolution/evidence/producers/name-confirmation';
import {
  evaluateBookingNameGate,
  evaluateBookingPhoneGate,
} from '@resolution/evidence/identity-gates';
import { getRuleFactValue } from '@resolution/evidence/merge';
import {
  extractCandidateTexts,
  extractCandidateTextsFromCorpus,
} from '@resolution/signal/self-report';
import {
  BOOKING_CRITICAL_FIELDS,
  computeCandidateMessageWatermark,
} from '@resolution/evidence/snapshot';
import { candidateValuesEquivalent } from '@resolution/evidence/normalize';
import { evaluateSnapshotGate } from '@resolution/evidence/snapshot-gate';
import { selectEvidenceDialogueMessages } from '@resolution/signal/corpus';
import type { CandidateSnapshotService } from '@memory/services/candidate-snapshot.service';
import type { AgentEvent } from '@/observability/observer.interface';

const logger = new Logger('duliday_interview_booking');
const INTERVIEW_TIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * 预约软查重时间窗：候选人近期已对同一岗位产生 active_booking 时，再次提交视为重复
 * （Bull 重试 / Agent 同会话重复调用），直接拦截，避免在海绵生成第二张同岗位工单。
 * 不再按候选人维度一刀切拦截：候选人可以同时报名多个不同岗位。
 */
const BOOKING_DEDUP_WINDOW_MS = 30 * 60 * 1000;

function markBookingFailed<T extends Record<string, unknown>>(
  context: ToolBuildContext,
  result: T,
): T {
  context.ledger.jobs.bookingSucceeded = false;
  return result;
}

function pauseUserHostingAsync(
  userHostingService: UserHostingService,
  chatId: string,
  successMessage: string,
): void {
  void userHostingService
    .pauseUser(chatId, { source: 'interview_booking', reason: '约面成功自动暂停' })
    .then(() => {
      logger.log(successMessage);
    })
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? (error.stack ?? error.message) : String(error);
      logger.error(`[自动暂停] 暂停托管失败: chatId=${chatId}`, errorMessage);
    });
}

function isRecentBooking(booking: ActiveBookingEntry, now = Date.now()): boolean {
  const linkedAtMs = Date.parse(booking.linked_at);
  return Number.isFinite(linkedAtMs) && now - linkedAtMs < BOOKING_DEDUP_WINDOW_MS;
}

function isSameBookingTarget(booking: ActiveBookingEntry, jobId: number): boolean {
  // 旧数据没有 job_id，无法判断是否同岗位；保守按重复处理，避免部署前遗留指针导致
  // 同一候选人短时间 Bull 重试穿透。新写入的数据会带 job_id，可支持多岗位报名。
  if (booking.job_id == null) return true;
  return booking.job_id === jobId;
}

/** 归一化手机号用于比对：只保留数字，去掉空格/连字符等格式差异。 */
function normalizePhoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

interface BookingAuthorityFailure {
  missingEvidenceFields: string[];
  conflictingFields: string[];
}

/**
 * 代报豁免轨（core-flow-review 议题 8-1）。
 *
 * 事故（badcase chat 6a4229f2，2026-08-14）：中介联系人一轮给两个人报同一岗位，
 * 第一人成功、第二人被姓名/电话一致性闸门拒——闸门以**会话级单一身份**做比对，
 * 单人档案装不下第二人。产品裁定：同时服务多人是应该有的能力，不建子档案，
 * 只把报名链路上"假设单一身份"的闸门改为**按调用自包含验证**。
 *
 * 防臆造保护不降级，只是把验证源从"会话档案单一身份"换成"候选人消息文本逐字锚定"：
 * 姓名与手机号**都能**在本会话候选人消息里逐字找到，才按 candidate_quote 证据放行。
 * 这正是 candidate_quote 证据的本义——对粘贴表单场景比档案匹配更强（档案只有一个人，
 * 表单里两个人的姓名手机号都在原文里）。任一项找不到 → 回落原有会话档案一致性闸，
 * 张冠李戴/示例回声防线原样保留。
 */
function isProxyBookingAnchoredInCandidateText(
  context: ToolBuildContext,
  payload: { name: string; phone: string },
): boolean {
  const name = payload.name?.trim() ?? '';
  const phoneDigits = normalizePhoneDigits(payload.phone);
  // 单字姓名/短号会把任意句子吸成"逐字命中"，不给豁免。
  if (name.length < 2 || phoneDigits.length < 7) return false;

  const candidateTexts = context.turnInput.corpusBlocks
    ? extractCandidateTextsFromCorpus(context.turnInput.corpusBlocks)
    : extractCandidateTexts(context.turnInput.messages);
  // 与既有 quote 验证同口径：剥引用块与消息时间后缀，防止把引用的经理名当自陈。
  const normalizedTexts = candidateTexts.map((text) =>
    stripQuotedBlocks(stripTimeContextSuffix(text)),
  );

  const nameAnchored = normalizedTexts.some((text) => text.includes(name));
  const phoneAnchored = normalizedTexts.some((text) =>
    normalizePhoneDigits(text).includes(phoneDigits),
  );
  return nameAnchored && phoneAnchored;
}

function validateBookingCandidateAuthority(
  context: ToolBuildContext,
  payload: {
    name: string;
    phone: string;
    age: number;
    genderId: number;
    educationId?: number;
    householdRegisterProvinceId?: number;
    height?: number;
    weight?: number;
    hasHealthCertificate?: number;
  },
): BookingAuthorityFailure | null {
  // 生产 generator 始终注入该权威视图；直接工具单测/旧 debug 调用未注入时保持兼容。
  if (context.archive.bookingCandidateFacts === undefined) return null;

  // 代报豁免轨优先：payload 的姓名与手机号都能在候选人消息文本中逐字找到，
  // 说明本次调用自包含了这个人的身份证据，不需要它与会话单一身份一致。
  if (isProxyBookingAnchoredInCandidateText(context, payload)) return null;

  const facts = context.archive.bookingCandidateFacts;
  const missingEvidenceFields: string[] = [];
  const conflictingFields: string[] = [];
  const checks: Array<{ field: string; expected: unknown; actual: unknown; required: boolean }> = [
    { field: '姓名', expected: facts?.name, actual: payload.name, required: true },
    { field: '联系电话', expected: facts?.phone, actual: payload.phone, required: true },
  ];

  for (const check of checks) {
    if (!check.required) continue;
    const expected = normalizeBookingAuthorityValue(check.field, check.expected);
    const actual = normalizeBookingAuthorityValue(check.field, check.actual);
    if (!expected) {
      missingEvidenceFields.push(check.field);
    } else if (!actual || actual !== expected) {
      conflictingFields.push(check.field);
    }
  }

  return missingEvidenceFields.length > 0 || conflictingFields.length > 0
    ? { missingEvidenceFields, conflictingFields }
    : null;
}

function normalizeBookingAuthorityValue(field: string, value: unknown): string {
  if (value == null) return '';
  const text = String(value).trim().toLowerCase().replace(/\s+/g, '');
  if (field === '联系电话') return text.replace(/\D/g, '');
  if (field === '身高') return text.replace(/cm|厘米/g, '').replace(/\.0+$/, '');
  if (field === '体重') return text.replace(/kg|公斤|千克/g, '').replace(/\.0+$/, '');
  if (field === '户籍省份') {
    return text.replace(/壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市$/g, '');
  }
  if (field === '学历' && /中专|技校|职高/.test(text)) return '中专技校职高';
  if (field === '健康证情况') {
    if (/无.*不接受|不办|不接受办理/.test(text)) return '无且不接受办理健康证';
    if (/无.*接受|可以办|愿意办/.test(text)) return '无但接受办理健康证';
    if (/有/.test(text)) return '有';
  }
  return text;
}

const supplementAnswersSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    '岗位补充标签回答，key 必须逐字使用本岗位 precheck 返回的标签原文。标准字段对应标签会自动回填',
  );

const DESCRIPTION = `预约面试。真正调用面试预约接口，提交面试时间 + 候选人信息。入参必须与 supplier/entryUser 契约保持一致。

## 调用契约（必读）
本工具要求先完成 duliday_interview_precheck，并会在真实预约前对关键硬规则做服务端二次校验。漏调 precheck 或不按 precheck 的 nextAction 行动，会被直接拒绝。所以在调本工具之前，必须满足以下全部条件：

1. **本轮已经调过 duliday_interview_precheck**，且 nextAction === "ready_to_book"。任何 collect_fields / confirm_date / date_unavailable 状态都不得直接进 booking。**必须把本轮 precheck 返回的 nextAction + bookingChecklist.missingFields.length 原样填入入参 prechecked 字段**——后端会硬校验，缺该字段或 nextAction ≠ ready_to_book 或 missingFieldsCount > 0 直接拒，不会调真实预约接口。
2. **interviewTime 必须锚定 precheck 返回的 bookableSlots**：只有 bookingAllowed=true 的 slot 才能用；dateOnly=true / 00:00-00:00 / bookingAllowed=false 的 slot 必须由人工确认，禁止自动提交。窗口制时段（slot 的 startTime-endTime 是一段区间）下，候选人明确约定了窗口内某具体时刻（如"周四15:00"）时，**用「slot 日期 + 该时刻」提交**（如 2026-07-23 15:00:00），让工单如实记录候选人到场时间；候选人只定了日期没定时刻时才用 slot 自带的 interviewTime（窗口起点）。严禁提交窗口起止时间之外的时刻。"registrationDeadline / 报名截止"**绝不是面试时间**，严禁把它当作 interviewTime。**例外**：precheck 返回 interview.interviewTimeMode === "wait_notice"（岗位未配置面试时段，面试官电话联系）时，**不要传 interviewTime**，严禁自己编一个时间填进来。
3. **screeningChecks 必须已经向候选人核对完**：candidate 命中任一 failSignal 就停止收资、走 invite_to_group / request_handoff，**绝不能带着不合格答案来调本工具**。
4. **nameFieldGuard.suspicious=true 时**：必须先向候选人补问真实姓名，拿到合规的真名再调本工具；不得把昵称/占位串当 name 提交。
5. **班次硬约束**（"做一休一/每周最多两天/只周末/不上夜班/下班后/六点才下班"等）与岗位 workTime 不重叠时，禁止进入 booking；先用 duliday_job_list(includeWorkTime=true) 校验或换岗位。

## 前置（其它流程性要求）
- 若系统提示中已存在 [当前预约信息]，说明本会话已有 active 面试预约；候选人追问已报名岗位的面试时间/门店/岗位/预约状态时，直接基于 [当前预约信息] 回答，**同一岗位严禁再次调用本工具**
- 候选人明确要求“另一个/第二个/也帮我约”不同岗位时，可以继续对该新岗位走 duliday_interview_precheck → duliday_interview_booking；不要因为已存在其它岗位预约就拒绝多岗位报名
- 候选人要求改期/取消时，不要再次调用本工具：改时间用 duliday_modify_interview_time、取消用 duliday_cancel_work_order 自助处理（失败再按 request_handoff 转人工）
- 候选人反馈门店查不到预约或预约信息冲突，或说已面试/面试通过/店长已联系/只能一家店/正在报到培训办入职时，不要再次调用本工具，按 request_handoff 的规则转人工处理
- 需要 jobId。优先从 [会话记忆] 的「当前焦点岗位」中获取；若没有，再从「最近已展示岗位」或「上轮候选岗位池」中获取，或调用 duliday_job_list 查询
- 若预约所需信息中存在候选人尚未明确提供的字段（如学历、健康证情况），必须先向候选人确认；**严禁擅自默认"大专"、"有健康证"等值代填**
- 健康证、学历等信息优先结合岗位要求与约面重点解释；若岗位结果未明确展示但预约工具仍需要该字段，也要先向候选人确认，再调用工具

## 收集原则
- 正常收资场景下，优先一次性列出当前岗位真正需要候选人补充的全部信息，不要一轮一轮零碎补问
- 若候选人已经对信息量或流程表现出抗拒，暂停"一次性收齐"思路；先安抚、解释用途，再把请求压缩成最少一步
- 不要收集与当前岗位或当前预约无关的信息；若某字段不是这次预约所必需，就不要为了"收全资料"而额外索取

## 重试策略
- 失败需重试，最多 2 次

## 成功/失败处理硬规则
- **只有当本工具返回 success 后，才能向候选人确认面试安排并复述时间与门店**
- **严禁**在未调用本工具或调用未返回 success 的情况下，告知候选人面试已安排、可以去面试、面试时间地点等任何暗示预约成功的信息
- 失败处理：当工具返回 _replyInstruction 时，按该字段的指令自主组织一句口语化致歉+衔接的招募者话术（如"这边暂时没约上，我让同事确认一下，稍等"）
- 失败时严禁原样复读 _replyInstruction、严禁透露接口报错/技术细节、严禁继续推进其他任务`;

const inputSchema = z.object({
  jobId: z.number().int().describe('岗位ID'),
  interviewTime: z
    .string()
    .optional()
    .describe(
      '面试时间，格式必须为 YYYY-MM-DD HH:mm:ss，例如 2026-04-20 14:00:00。' +
        '仅当 precheck 返回 interview.interviewTimeMode === "wait_notice"（岗位未配置面试时段，面试官电话联系）时不传；' +
        '其余岗位必填，且必须锚定 precheck bookableSlots 中 bookingAllowed=true 的 slot：' +
        '候选人约定了窗口内具体时刻时用「slot 日期 + 该时刻」，否则用 slot 自带的 interviewTime（窗口起点）。',
    ),
  name: z.string().describe('姓名'),
  phone: z.string().describe('手机号'),
  age: z.number().int().describe('年龄，整数，范围 10-100'),
  genderId: z.number().int().describe('性别ID：1=男，2=女'),
  operateType: z
    .number()
    .int()
    .describe(
      '页面来源：1=用户名单新建，2=用户名单批量导入，3=在招岗位列表预约，4=岗位详情页预约，5=条件匹配列表页，6=ai导入',
    ),
  avatar: z.string().optional().describe('头像 URL'),
  householdRegisterProvinceId: z.number().int().optional().describe('户籍省 ID'),
  height: z.number().optional().describe('身高，单位 cm'),
  weight: z.number().optional().describe('体重，单位 kg'),
  hasHealthCertificate: z
    .number()
    .int()
    .optional()
    .describe('是否有健康证：1=有，2=无但接受办理，3=无且不接受办理'),
  healthCertificateTypes: z
    .array(z.number().int())
    .optional()
    .describe('健康证类型数组：1=食品健康证，2=零售健康证，3=其他健康证'),
  educationId: z
    .number()
    .int()
    .optional()
    .describe(
      '学历ID：1=不限，2=本科，3=大专，4=高中，5=初中，6=硕士，7=博士，8=中专技校职高，9=初中以下，10=高职',
    ),
  uploadResume: z.string().optional().describe('简历附件 URL'),
  supplementAnswers: supplementAnswersSchema,
  logId: z.number().int().optional().describe('智能识别日志 ID'),
  brandName: z.string().optional().describe('品牌名称，仅用于通知展示'),
  storeName: z.string().optional().describe('门店名称，仅用于通知展示'),
  jobName: z.string().optional().describe('岗位名称，仅用于通知展示'),
  precheckId: z
    .string()
    .optional()
    .describe(
      '本轮 duliday_interview_precheck 返回的 factAdjudication.precheckId，原样回传。' +
        '系统用它核对你提交的最终资料与预检裁决快照一致（防止旧记忆资料在预检后混入）。' +
        'precheck 没有返回该字段时不传，禁止编造。',
    ),
  prechecked: z
    .object({
      nextAction: z
        .enum([
          'ready_to_book',
          'collect_fields',
          'confirm_date',
          'date_unavailable',
          'student_rejected',
          'household_rejected',
          'confirm_local_health_certificate',
          'wait_for_health_certificate',
          'health_certificate_rejected',
        ])
        .describe('本轮 duliday_interview_precheck 返回的 nextAction 字段，必须复制原值'),
      missingFieldsCount: z
        .number()
        .int()
        .min(0)
        .describe('本轮 precheck 返回的 bookingChecklist.missingFields 长度'),
    })
    .optional()
    .describe(
      '【硬约束】调本工具前必须先调 duliday_interview_precheck，把返回结果中的 nextAction 与 missingFieldsCount 原样填入本字段。' +
        `漏填、nextAction !== "ready_to_book" 或 missingFieldsCount > 0 时，booking 工具直接返回 ${TOOL_ERROR_TYPES.BOOKING_REJECTED}，不会调 sponge API。` +
        '字段技术上可选只是为了让 schema 不卡校验、缺失时能走友好错误返回（带 replyInstruction），业务语义上仍必填——' +
        '如果本轮没调 precheck，**不要瞎填**，直接漏掉，工具会回错让你先去调 precheck。',
    ),
});

/**
 * booking 快照对账依赖（可选注入；缺省时对账静默跳过，test/debug 直建工具零改动）。
 * mode=shadow：差异只落观测与日志；mode=enforce：差异直接拒绝提交要求重新 precheck。
 */
export interface BookingAdjudicationDeps {
  mode: 'shadow' | 'enforce';
  snapshots?: Pick<CandidateSnapshotService, 'load'>;
  observer?: { emit: (event: AgentEvent) => void };
}

export interface InterviewBookingNotificationInfo {
  contactName?: string;
  candidateName: string;
  phone: string;
  genderLabel?: string;
  ageText?: string;
  botUserName?: string;
  brandName?: string;
  storeName?: string;
  jobName?: string;
  jobId?: number;
  interviewTime: string;
  interviewType?: string;
  toolOutput: Record<string, unknown>;
  botImId?: string;
}

export function buildInterviewBookingTool(
  spongeService: SpongeService,
  privateChatNotifier: PrivateChatMonitorNotifierService,
  userHostingService: UserHostingService,
  longTermService: LongTermService,
  opsEventsRecorder: OpsEventsRecorderService,
  adjudicationDeps?: BookingAdjudicationDeps,
): ToolBuilder {
  return (context) => {
    const spongeTokenContext = buildSpongeTokenContext(context);
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({
        jobId,
        interviewTime,
        name,
        phone,
        age,
        genderId,
        operateType,
        avatar,
        householdRegisterProvinceId,
        height,
        weight,
        hasHealthCertificate,
        healthCertificateTypes,
        educationId,
        uploadResume,
        supplementAnswers,
        logId,
        brandName,
        storeName,
        jobName,
        prechecked,
        precheckId,
      }) => {
        // 测试链路 PII 白名单闸门：booking 真调海绵生产网关，测试重放必须用
        // 假身份（2026-07-27 误建真实工单 453264 事故后固化为系统校验）。
        if (context.runtime.strategySource === 'testing' && !isTestPiiPhoneAllowed(phone)) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.TEST_LINK_REAL_PII_BLOCKED,
              outcome: '测试链路拦截：手机号不在测试白名单，未执行真实报名',
              replyInstruction:
                '当前为测试链路且候选人手机号不是测试假身份，本工具已拒绝提交、未产生任何真实工单。' +
                '不得谎称已报名/已登记；请如实说明报名未提交。测试用例应使用统一假身份（兮兮/13800000000）。',
              details: { phone: maskPhoneForDetails(phone) },
            }),
          );
        }
        // Phase 2-lite.1：precheck 契约硬约束。booking 完全信任 precheck 结论，
        // LLM 必须把本轮 precheck 的 nextAction + missingFieldsCount 显式传进来；
        // 任一不满足 ready_to_book 则直接拒，不进 sponge API。
        // 缺 prechecked 等价于"未调 precheck"——schema 层故意松绑成 optional，
        // 让漏调场景走 buildToolError 返回 replyInstruction，而不是被 Vercel AI SDK
        // 在 schema 校验阶段拒掉（那会让 LLM 拿到 raw schema error 循环重试）。
        if (!prechecked) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
              outcome: '预约失败（未先调 duliday_interview_precheck）',
              replyInstruction:
                'booking 强依赖 precheck 闸门，但本轮入参缺 prechecked。先调 duliday_interview_precheck 拿到 nextAction + bookingChecklist.missingFields.length，' +
                '把 nextAction === "ready_to_book" 且 missingFieldsCount === 0 的结果原样填入 prechecked，再来调本工具。' +
                '不要凭空猜 prechecked 的值。',
              details: { prechecked: null },
            }),
          );
        }
        if (prechecked.nextAction !== 'ready_to_book') {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
              outcome: `预约失败（precheck nextAction=${prechecked.nextAction}，未达 ready_to_book）`,
              replyInstruction:
                prechecked.nextAction === 'collect_fields'
                  ? '上一轮 precheck 仍要求继续收资，禁止直接进入 booking。回到 duliday_interview_precheck 拿 missingFields/templateText 把候选人字段收齐，再调本工具。'
                  : prechecked.nextAction === 'confirm_date'
                    ? '上一轮 precheck 要求先和候选人确认日期，禁止直接 booking。和候选人对齐 requestedDate 后重新调 precheck，nextAction=ready_to_book 才能调本工具。'
                    : prechecked.nextAction === 'student_rejected'
                      ? '上一轮 precheck 已确认候选人学生身份与岗位要求冲突，严禁继续 booking。转查接受学生的岗位；不得修改或隐瞒身份重试。'
                      : prechecked.nextAction === 'household_rejected'
                        ? '上一轮 precheck 已确认候选人与岗位内部硬性条件不匹配，严禁继续 booking。请用中性话术转查其它岗位；禁止透露具体户籍、籍贯或地域限制，也不得修改户籍字段重试。'
                        : prechecked.nextAction === 'confirm_local_health_certificate'
                          ? '候选人当前持有异地健康证，尚未确认是否接受重新办理应聘城市本地证。禁止 booking；先按 precheck.healthCertificateEligibility.recommendedQuestion 询问，得到明确答复后重新 precheck。'
                          : prechecked.nextAction === 'wait_for_health_certificate'
                            ? '当前岗位要求面试前持有健康证，候选人目前无证、在办或仅愿意办理，严禁 booking。请候选人拿到证后再联系，并重新查询届时岗位在招状态与可约时段；禁止承诺届时一定能约上。'
                            : prechecked.nextAction === 'health_certificate_rejected'
                              ? '候选人明确不接受办理本地健康证，不满足当前岗位已配置的健康证要求，严禁 booking。礼貌说明当前岗位暂不匹配并停止本岗位推进。'
                              : '上一轮 precheck 判定 date_unavailable（候选人请求日期不可约或被 available_after 拦截）。先解释原因并和候选人对齐其他日期，重新调 precheck，禁止本轮 booking。',
              details: { prechecked },
            }),
          );
        }
        if (prechecked.missingFieldsCount > 0) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
              outcome: `预约失败（precheck.missingFieldsCount=${prechecked.missingFieldsCount}）`,
              replyInstruction:
                'precheck 仍有未收齐字段，禁止直接 booking。回到 duliday_interview_precheck 看 bookingChecklist.missingFields 把字段收齐再来。',
              details: { prechecked },
            }),
          );
        }
        // jobId provenance 闸门（成员判定，precheck 同型，booking 侧 defense-in-depth）：传入 jobId
        // 不在本会话真实召回集时必是凭空生成或"召回 A 岗另编真实 B 岗 jobId"。precheck 已拦一次，
        // 但模型可能伪造 prechecked 直接进 booking，故这里再拦一道——避免"臆造/串改 jobId 命中真岗位
        // → 用假身份给真岗位下真预约"的 P0。
        if (context.archive.isRecalledJobId && !context.archive.isRecalledJobId(jobId)) {
          return markBookingFailed(context, {
            ...buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_JOB_NOT_PROVIDED,
              outcome: '预约拦截（jobId 无召回出处）',
              replyInstruction:
                'runtime 已短路本轮，禁止继续生成回复或调用其他工具；该会话需要人工确认 jobId 来源。' +
                ((context.archive.recalledJobIds ?? []).length === 0
                  ? '本会话还没有通过 duliday_job_list 召回过任何岗位，当前 jobId 没有合法来源，禁止凭空 booking。'
                  : `当前 jobId=${jobId} 不在本会话召回过的岗位里（合法的只有：${(
                      context.archive.recalledJobIds ?? []
                    ).join('、')}），禁止凭空 booking。`) +
                '先调 duliday_job_list 召回岗位拿真实 jobId，再走 duliday_interview_precheck，nextAction=ready_to_book 后才能调本工具。',
              details: { jobId, recalledJobIds: context.archive.recalledJobIds ?? [] },
            }),
            shortCircuited: true,
            gateRejected: true,
            reasonCode: 'job_id_not_recalled',
          });
        }
        logger.log(`预约面试: ${name}, jobId=${jobId}`);

        // recruitment_cases 已废弃：不再用 active case 查重。重复预约由海绵侧约束 +
        // active_booking 指针体现；提交前的本地软查重见下方 spongeService.bookInterview 调用前。

        // interviewTime 不在这里查缺：是否必填取决于岗位有没有配置面试时段
        // （等通知岗位合法缺省），要等拿到岗位详情后再判（见下方 interviewTimeWaitNotice）。
        const missingFields = [
          { field: 'jobId', value: jobId },
          { field: 'name', value: name },
          { field: 'phone', value: phone },
          { field: 'age', value: age },
          { field: 'genderId', value: genderId },
          { field: 'operateType', value: operateType },
        ]
          .filter(({ value }) => value == null || value === '')
          .map(({ field }) => field);

        if (missingFields.length > 0) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
              outcome: '预约失败（缺少必填字段）',
              replyInstruction:
                '预约入参不完整，按 missingFields 列出的字段逐项向候选人补问；禁止把字段名原文展示给候选人。',
              details: {
                missingFields,
                requiredPayloadFields: [...API_BOOKING_REQUIRED_PAYLOAD_FIELDS],
                detailedReason: `缺少预约接口必填字段：${missingFields.join('、')}`,
              },
            }),
          );
        }

        // 预检裁决快照先载入：姓名闸门的「quote 作证」与报名级确认级判据都读它。
        // 载不到按 fail open 走既有闸门；下方对账闸复用同一份，不重复 IO。
        const precheckSnapshot =
          precheckId && adjudicationDeps?.snapshots
            ? await adjudicationDeps.snapshots
                .load(context.session.corpId, context.session.userId, precheckId)
                .catch((error: unknown) => {
                  logger.warn(
                    `[booking] 预检快照载入异常（fail open）: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                  return null;
                })
            : null;
        const enforcing = adjudicationDeps?.mode === 'enforce';
        const evidenceMessages = context.turnInput.corpusBlocks
          ? selectEvidenceDialogueMessages(context.turnInput.corpusBlocks)
          : (context.turnInput.messages ?? []);
        // E2 quote 作证收紧为确认级：confirmedFields 只含 operation=confirm /
        // context_confirmation 的 accepted claim（precheck 快照构造处即该口径），
        // acceptedClaimId 判据排除 session 基线（基线无 claimId）。候选人本人确认过的
        // 名字可压过打招呼语负向结论（P11 终审条款）；statement 级 claim 不解锁负向证据。
        const nameConfirmAttested =
          Boolean(precheckSnapshot?.confirmedFields.includes('name')) &&
          precheckSnapshot?.effectiveProfile.fields.name?.status === 'accepted' &&
          precheckSnapshot.effectiveProfile.fields.name.acceptedClaimId != null &&
          candidateValuesEquivalent(
            'name',
            precheckSnapshot.effectiveProfile.fields.name.value,
            name,
          );

        // HC-2 姓名权威闸门（booking 侧 defense-in-depth，负向证据）：name 在原文里仅以
        // "我是X"打招呼语昵称出现时拒——这是 runBookingGuards.checkRealName 纯形态校验拦不住的
        // 缺口（2-4 字昵称形态合法但只是微信打招呼昵称）。先确认真名再约，不得拿昵称下真预约。
        const nameGate = evaluateBookingNameGate(name, evidenceMessages, {
          // shadow 零行为：作证放行 enforce 起生效；shadow 期解锁由 legacy 正则承担（偏离⑥）。
          attestedByClaim: enforcing && nameConfirmAttested,
          allowLegacyConfirmRegex: !enforcing,
        });
        if (nameGate.decision === 'reject_collect') {
          // 同题限问（badcase g4ytra23：重复索名 4 遍）：已问过 ≥2 次仍未通过校验时，
          // 不再让模型继续追问，改走 request_handoff 由真人核实，避免死循环消耗候选人耐心。
          const nameAskCount = countRealNameAsks(evidenceMessages);
          const replyInstruction =
            nameAskCount >= 2
              ? `${nameGate.reason}。你已就"真实姓名"向候选人索要过 ${nameAskCount} 次，禁止再重复索要。` +
                '请调用 request_handoff（reasonCode=booking_conflict，reason 注明"姓名多次校验未通过需人工核实"）转人工，' +
                '并向候选人自然回复一句承接语（如"好嘞，我这边帮你核对登记，稍后回你"）；不得再次询问姓名，不得提及校验/系统。'
              : `${nameGate.reason}。请用"门店登记需要本名"等自然话术先向候选人确认真实姓名，` +
                '拿到真名后再调 duliday_interview_precheck/本工具；禁止把微信昵称或"我是XX"里的昵称当姓名提交。';
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
              outcome: '预约失败（姓名疑似打招呼语昵称）',
              replyInstruction,
              details: { suspiciousName: name, nameAskCount },
            }),
          );
        }

        // B4 手机号溯源闸门（正向证据）：手机号必须能在候选人原文里找到出处。抽取示例回声
        // 臆造的档案曾经"沿用"洗白后带编造手机号直达 booking（badcase 6e9ar9gd 簇），姓名之外
        // 错误代价最高的字段是手机号——门店按它联系候选人，错号=预约作废+候选人失联。
        const phoneGate = evaluateBookingPhoneGate(phone, evidenceMessages);
        if (phoneGate.decision === 'reject_collect') {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
              outcome: '预约失败（手机号无候选人原文出处）',
              replyInstruction:
                `${phoneGate.reason}。请用"方便留个联系电话吗，门店面试前会联系你"等自然话术向候选人索要手机号，` +
                '拿到候选人亲口发的号码后再调 duliday_interview_precheck/本工具；禁止沿用记忆档案或历史记录里来源不明的号码。',
              details: { suspiciousPhone: phone },
            }),
          );
        }

        // D3 报名级确认级终审网：公证三问全过也不等于值对——「我姐今年24」引文真实、
        // 形状合法、不回声，三问一路绿灯。姓名/电话已各有出处闸门（上方两道），年龄
        // 此前一道都没有，这里补齐。shadow 期只记不拦。
        const unconfirmedCriticalFields = precheckSnapshot
          ? BOOKING_CRITICAL_FIELDS.filter(
              (field) =>
                !precheckSnapshot.confirmedFields.includes(field) &&
                // 姓名/电话的直接自陈出处已由上方两道闸门逐字验过（原文里找得到号码、
                // 找不到打招呼语昵称/引用前缀名），走到这里即视为已有等效证据。年龄没有
                // 任何出处闸门——"24"这两个字在原文里一定找得到，找到了也证明不了它是
                // 候选人的年龄——所以它只认候选人本人的一次明确表态。
                field === 'age',
            )
          : [];
        if (enforcing && unconfirmedCriticalFields.length > 0) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
              outcome: '预约失败（报名级字段未经候选人确认）',
              replyInstruction:
                `${unconfirmedCriticalFields.join('、')} 尚未由候选人本人确认过。` +
                '请把该字段随收资表复述一次让候选人过目（如"年龄24，对吧？如有误请改"），' +
                '候选人认可后，用 duliday_interview_precheck 的 candidateClaims 以 operation="confirm" ' +
                '提交这条确认对答（quote 填候选人的应答原话，agentQuestionQuote 填你的复述问句），' +
                '拿到新的 precheckId 后再调本工具。禁止跳过确认直接重试。',
              details: { unconfirmedCriticalFields },
            }),
          );
        }

        if (interviewTime != null && !INTERVIEW_TIME_REGEX.test(interviewTime)) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME,
              outcome: '预约失败（interviewTime 格式错误）',
              replyInstruction:
                'interviewTime 必须为 YYYY-MM-DD HH:mm:ss 格式。先调用 duliday_interview_precheck 拿到合法 slot 再 重新调本工具，禁止凭印象拼接时间；' +
                '若 precheck 显示 interview.interviewTimeMode === "wait_notice"，则不要传本字段。',
            }),
          );
        }

        if (!Number.isInteger(age) || age < 10 || age > 100) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_AGE,
              outcome: '预约失败（年龄字段非法）',
              replyInstruction: 'age 必须 10-100 整数。向候选人确认年龄后重试；禁止凭印象填写。',
            }),
          );
        }

        if (!(genderId in SPONGE_GENDER_MAPPING)) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_GENDER_ID,
              outcome: '预约失败（性别字段非法）',
              replyInstruction: 'genderId 仅支持 1=男、2=女。向候选人确认性别后重试。',
            }),
          );
        }

        if (!(operateType in SPONGE_OPERATE_TYPE_MAPPING)) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_OPERATE_TYPE,
              outcome: '预约失败（operateType 非法）',
              replyInstruction:
                'operateType 仅支持 1-6，ai 导入场景请传 6。这是工具自身的入参约束，不要向候选人提及。',
            }),
          );
        }

        if (educationId != null && !(educationId in SPONGE_EDUCATION_MAPPING)) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_EDUCATION_ID,
              outcome: '预约失败（学历 ID 非法）',
              replyInstruction:
                'educationId 不在合法枚举内。向候选人确认学历（如本科、大专、高中）再按 availableEducationIds 映射。',
              details: {
                availableEducationIds: SPONGE_EDUCATION_MAPPING,
                detailedReason: `educationId 无效：${educationId}`,
              },
            }),
          );
        }

        if (
          hasHealthCertificate != null &&
          !(hasHealthCertificate in SPONGE_HEALTH_CERTIFICATE_MAPPING)
        ) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_HEALTH_CERTIFICATE,
              outcome: '预约失败（健康证字段非法）',
              replyInstruction:
                'hasHealthCertificate 仅支持 1=有、2=无但接受办理、3=无且不接受办理。向候选人确认健康证情况后重试。',
            }),
          );
        }

        if (
          healthCertificateTypes?.some(
            (value) =>
              !Number.isInteger(value) || !(value in SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING),
          )
        ) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_HEALTH_CERTIFICATE_TYPES,
              outcome: '预约失败（健康证类型非法）',
              replyInstruction:
                'healthCertificateTypes 仅支持 1=食品健康证、2=零售健康证、3=其他健康证。向候选人确认健康证类型后重试。',
            }),
          );
        }

        // 只保留姓名/电话的跨工具一致性校验，防止候选人串档。其他报名字段以本次
        // booking 显式入参为准，不再因预检快照不同步而硬拒。
        const authorityFailure = validateBookingCandidateAuthority(context, {
          name,
          phone,
          age,
          genderId,
          educationId,
          householdRegisterProvinceId,
          height,
          weight,
          hasHealthCertificate,
        });
        if (authorityFailure) {
          logger.warn(
            `[booking] 候选人字段权威性校验拒绝: chatId=${context.session.sessionId}, ` +
              `missing=${authorityFailure.missingEvidenceFields.join('|') || '-'}, ` +
              `conflict=${authorityFailure.conflictingFields.join('|') || '-'}`,
          );
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
              outcome: '预约失败（姓名或联系电话与预检结果不一致）',
              replyInstruction:
                '只需按 missingEvidenceFields / conflictingFields 核对姓名和联系电话，采用本次候选人资料重新 precheck；' +
                '年龄、性别、学历、健康证、户籍、身高和体重不受此一致性闸门限制。',
              details: { ...authorityFailure },
            }),
          );
        }

        // —— PrecheckSnapshot 对账闸（证据化 Phase 3，§10 灰度：差异记录先行）——
        // 模型回传 precheckId 时，载入预检裁决快照核对最终 payload：水位失效
        // （precheck 后候选人又发消息）与字段偏离（模型混入旧记忆值）都会被记录。
        // shadow 只落观测；enforce 直接拒绝要求重新 precheck。快照缺失按 fail open
        // 放行（Redis 抖动/TTL 过期不得阻断报名）。
        if (precheckId && adjudicationDeps?.snapshots) {
          try {
            const snapshot = precheckSnapshot;
            if (snapshot) {
              const gate = evaluateSnapshotGate({
                snapshot,
                payload: { name, phone, age, genderId, height, weight, hasHealthCertificate },
                jobId,
                currentMessageWatermark: computeCandidateMessageWatermark(
                  context.turnInput.corpusBlocks
                    ? extractCandidateTextsFromCorpus(context.turnInput.corpusBlocks)
                    : extractCandidateTexts(context.turnInput.messages),
                ),
              });
              if (gate.mismatchedFields.length > 0) {
                logger.warn(
                  `[booking] 快照对账不一致(${adjudicationDeps.mode}): chatId=${context.session.sessionId}, ` +
                    `precheckId=${precheckId}, mismatch=${gate.mismatchedFields.join('|')}`,
                );
                adjudicationDeps.observer?.emit({
                  type: 'fact_adjudication',
                  stage: 'booking_gate',
                  mode: adjudicationDeps.mode,
                  userId: context.session.userId,
                  precheckId,
                  factsVersion: snapshot.factsVersion,
                  decisions: [],
                  mismatchedFields: gate.mismatchedFields,
                });
                if (adjudicationDeps.mode === 'enforce') {
                  return markBookingFailed(
                    context,
                    buildToolError({
                      errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                      outcome: '预约失败（提交资料与预检裁决快照不一致）',
                      replyInstruction:
                        `提交的资料与本轮预检快照不一致（${gate.mismatchedFields.join('、')}）。` +
                        '候选人可能刚补充了新资料，或部分入参没有候选人原话依据。' +
                        '重新调 duliday_interview_precheck（把候选人最新明确提供的资料经 candidateClaims 附原话提交），' +
                        '拿到新的 precheckId 后再 booking。禁止沿用旧值直接重试。',
                      details: { precheckId, mismatchedFields: gate.mismatchedFields },
                    }),
                  );
                }
              }
            }
          } catch (error) {
            logger.warn(
              `[booking] 快照对账异常（fail open）: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }

        const resolvedUploadResume = resolveUploadResume(uploadResume, context);
        const genderLabel = getSpongeGenderLabelById(genderId) ?? undefined;
        const ageText = normalizeAgeText(age);
        let interviewType: string | undefined;
        let manualInterviewGroupHandling: ManualInterviewGroupHandling | null = null;
        let requestInfo: Record<string, unknown> = {
          jobId,
          interviewTime,
          name,
          phone,
          age,
          genderId,
          operateType,
          avatar,
          householdRegisterProvinceId,
          height,
          weight,
          hasHealthCertificate,
          healthCertificateTypes,
          educationId,
          uploadResume: resolvedUploadResume,
          supplementAnswers,
          logId,
        };

        try {
          const { jobs } = await spongeService.fetchJobs(
            {
              jobIdList: [jobId],
              pageNum: 1,
              pageSize: 1,
              options: {
                includeBasicInfo: true,
                includeHiringRequirement: true,
                includeInterviewProcess: true,
              },
            },
            spongeTokenContext,
          );

          const job = jobs[0];
          if (!job?.basicInfo) {
            // 与 precheck 同口径：岗位已失效，同步从会话记忆剔除，避免下一轮重试死岗位。
            context.ledger.markJobInvalidated?.(jobId);
            return markBookingFailed(
              context,
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_JOB_NOT_FOUND,
                outcome: '预约失败（岗位已失效）',
                replyInstruction:
                  `jobId=${jobId} 这个岗位已经查不到（下架或名额已满），已从会话岗位记忆中移除。` +
                  '**禁止再用同一个 jobId 重试本工具**。用招募者口吻安抚"我帮你查下这家店"，' +
                  '再调用 duliday_job_list 重新召回可选岗位；不要透露 jobId 或接口细节。',
                details: {
                  jobId,
                  detailedReason: `未找到 jobId=${jobId} 对应的岗位，无法回填 customerLabelList`,
                },
              }),
            );
          }

          // 无面试时段（等通知）岗位：平台名单录入的"预约时间"显示"等待通知"，
          // 预约提交不带 interviewTime，由面试官在报名后直接电话联系候选人。
          // interviewTime 缺省对这类岗位合法。判定与 precheck 共用 isWaitNoticeInterview，
          // 同时覆盖「无时段」与「有时段但先审简历后通知」两种语义，避免 precheck 放行
          // wait_notice 而 booking 仍按"有时段"要 interviewTime 把预约打回（badcase chat 6a2fac72…）。
          const interviewTimeWaitNotice = isWaitNoticeInterview(buildJobPolicyAnalysis(job));
          if (interviewTime == null && !interviewTimeWaitNotice) {
            return markBookingFailed(
              context,
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
                outcome: '预约失败（缺少 interviewTime）',
                replyInstruction:
                  '该岗位配置了面试时段，interviewTime 必填。先调 duliday_interview_precheck 拿 bookableSlots 中 ' +
                  'bookingAllowed=true 的 slot，再带 interviewTime 重新调本工具；禁止凭印象拼接时间。',
                details: { missingFields: ['interviewTime'] },
              }),
            );
          }

          // Defense-in-depth: 在调 sponge bookInterview 之前再跑一次 precheck 已经做过的
          // 四类硬规则校验（真名 / 时段 / 筛选答案 / 岗位硬性约束）。LLM 偶发会跳过 precheck 直接调本工具，
          // 这里作为 server-side 兜底——详见 booking-guards.util.ts。
          const guardFailure = runBookingGuards({
            job,
            name,
            interviewTime,
            supplementAnswers,
            candidateGenderId: genderId,
            candidateHasHealthCertificate: hasHealthCertificate,
            candidateHealthCertificateFact:
              getRuleFactValue<string>(
                context.ledger.facts.ruleFacts,
                'interview_info.has_health_certificate',
                { minConfidence: 'high' },
              ) ?? context.archive.sessionFacts?.interview_info.has_health_certificate,
            candidateIsStudent: resolveCandidateIsStudentForBooking(context),
            candidateHouseholdProvinceId: householdRegisterProvinceId,
          });
          if (guardFailure) {
            return markBookingFailed(context, guardFailure);
          }

          const supplementDefinitions = extractInterviewSupplementDefinitions(job);
          const bookingUploadResume = await resolveUploadResumeForBooking(
            resolvedUploadResume,
            context,
            spongeService,
          );
          if (isResumeRequiredByJob(job, supplementDefinitions) && !bookingUploadResume) {
            const missingResumeLabels = getResumeSupplementLabels(supplementDefinitions);
            return markBookingFailed(
              context,
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES,
                outcome: '预约失败（岗位要求上传简历附件）',
                replyInstruction:
                  '该岗位要求上传简历附件，不能用文字经历或口述工作经历替代。请让候选人发送 PDF 简历文件，或拍照发送简历图片（手写简历也可以）；收到后系统会识别出"简历附件：URL"，再重新调用 booking。',
                details: {
                  missingFields: ['简历附件'],
                  missingSupplementLabels:
                    missingResumeLabels.length > 0 ? missingResumeLabels : ['简历附件'],
                  detailedReason:
                    '岗位要求上传简历，但 booking 入参、会话记忆和当前文件消息中都没有可提交的 uploadResume/cloudStorageKey。',
                },
              }),
            );
          }

          const customerLabelResolution = buildCustomerLabelList({
            supplementDefinitions,
            context,
            name,
            phone,
            age,
            genderId,
            interviewTime,
            householdRegisterProvinceId,
            height,
            weight,
            hasHealthCertificate,
            healthCertificateTypes,
            educationId,
            uploadResume: bookingUploadResume,
            supplementAnswers,
          });

          if (customerLabelResolution.success === false) {
            const missingResumeLabels =
              customerLabelResolution.missingSupplementLabels?.filter(isResumeLabel) ?? [];
            return markBookingFailed(
              context,
              buildToolError({
                errorType: customerLabelResolution.errorType,
                outcome:
                  customerLabelResolution.errorType ===
                  TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES
                    ? '预约失败（岗位补充标签缺值）'
                    : '预约失败（岗位补充标签取值非法）',
                replyInstruction:
                  missingResumeLabels.length > 0
                    ? '岗位要求上传简历附件，不能用文字经历或口述工作经历替代。请让候选人发送 PDF 简历文件；收到文件后先按附件上传链路拿到云存储 key，再重新调用 booking。'
                    : '岗位补充标签未填齐或取值非法。按 missingSupplementLabels / invalidSupplementLabels 列出的字段名向候选人补问；' +
                      '不要把字段原文展示给候选人，更不要透露后台规则；补全后重新调用本工具。',
                details: {
                  missingSupplementLabels: customerLabelResolution.missingSupplementLabels,
                  invalidSupplementLabels: customerLabelResolution.invalidSupplementLabels,
                  customerLabelDefinitions: customerLabelResolution.customerLabelDefinitions,
                  detailedReason: customerLabelResolution.error,
                },
              }),
            );
          }

          const bookingCustomerLabelList = withBookingUploadResumeCustomerLabels(
            customerLabelResolution.customerLabelList,
            bookingUploadResume,
          );

          const resolvedBrandName =
            brandName || normalizeText(job.basicInfo.brandName) || undefined;
          const resolvedStoreName = storeName || resolveStoreName(job) || undefined;
          const resolvedJobName =
            jobName ||
            normalizeText(job.basicInfo.jobName) ||
            normalizeText(job.basicInfo.jobNickName) ||
            undefined;
          interviewType = resolveInterviewType(job);
          const bookingPolicyAnalysis = buildJobPolicyAnalysis(job);
          manualInterviewGroupHandling = resolveManualInterviewGroupHandling({
            interviewRemark: bookingPolicyAnalysis.normalizedRequirements.interviewRemark,
            flowDescription: bookingPolicyAnalysis.interviewMeta.demand,
          });
          const onlineInterview = isOnlineInterview({
            interviewType,
            interviewRemark: bookingPolicyAnalysis.normalizedRequirements.interviewRemark,
            flowDescription: bookingPolicyAnalysis.interviewMeta.demand,
          });
          requestInfo = {
            jobId,
            interviewTime,
            brandName: resolvedBrandName,
            storeName: resolvedStoreName,
            jobName: resolvedJobName,
            interviewType,
            name,
            phone,
            age,
            genderId,
            operateType,
            avatar,
            householdRegisterProvinceId,
            height,
            weight,
            hasHealthCertificate,
            healthCertificateTypes,
            educationId,
            uploadResume: bookingUploadResume,
            customerLabelList: bookingCustomerLabelList,
            supplementAnswers,
            logId,
          };

          // 提交前软查重：重复预约主要靠海绵约束 + active_booking
          // 指针体现。这里补一道本地兜底——仅当候选人窗口内已有「同岗位」active_booking
          // 时拦截，避免 Bull 重试 / Agent 同会话重复调用生成第二张同岗位工单。
          // 不同岗位不拦截，支持候选人同时报名多个岗位。
          const activeBookings = await longTermService
            .getActiveBookings(context.session.corpId, context.session.userId)
            .catch(() => null);
          const recentSameJobBooking = (activeBookings ?? []).find(
            (booking) => isRecentBooking(booking) && isSameBookingTarget(booking, jobId),
          );
          // 软查重按「企微联系人 + 岗位」定位，但一个企微号可能先后给不同的人报同一岗位
          // （工单 448367→448402 事故：罗欣宇约成功后，同会话给许颖约同岗位被误判重复）。
          // 命中指针后再用 work_order_id 反查工单上的手机号：手机号不同 = 不同候选人，放行。
          //
          // 议题 8-2（用户 8-14 裁定）：**查不到既有工单手机号时也放行**，交海绵仲裁。
          // 原"查不到就保守判重"分支在 badcase chat 6a4229f2 里击穿了这条修复本身——
          // 刚创建 8 分钟的工单海绵侧查不到手机号，手机号明确不同的第二位候选人被误拦，
          // 模型还据此向候选人编造了拒绝理由。真重复由海绵服务端同手机号同岗位约束兜底
          // （Bull 重试必然同 phone，海绵会拒），不因放行而产生重复工单。
          let duplicateBooking = recentSameJobBooking;
          if (recentSameJobBooking?.work_order_id != null) {
            const existingWorkOrder = await spongeService
              .getCachedWorkOrderById(recentSameJobBooking.work_order_id, spongeTokenContext)
              .catch(() => null);
            const existingPhone = normalizePhoneDigits(existingWorkOrder?.phone);
            const currentPhone = normalizePhoneDigits(phone);
            if (!existingPhone) {
              logger.log(
                `[booking] 近期同岗位 active_booking 查不到工单手机号，放行交海绵仲裁: ` +
                  `chatId=${context.session.sessionId}, jobId=${jobId}, workOrderId=${recentSameJobBooking.work_order_id}`,
              );
              duplicateBooking = undefined;
            } else if (currentPhone && existingPhone !== currentPhone) {
              logger.log(
                `[booking] 近期同岗位 active_booking 手机号与本次不同，判定为不同候选人，放行: ` +
                  `chatId=${context.session.sessionId}, jobId=${jobId}, workOrderId=${recentSameJobBooking.work_order_id}`,
              );
              duplicateBooking = undefined;
            }
          }
          if (duplicateBooking?.work_order_id != null) {
            logger.warn(
              `[booking] 命中近期同岗位 active_booking 软查重，跳过重复提交: chatId=${context.session.sessionId}, jobId=${jobId}, workOrderId=${duplicateBooking.work_order_id}`,
            );
            // 候选人确已预约 → bookingSucceeded 置 true（不阻断后续拉群等流程）。
            context.ledger.jobs.bookingSucceeded = true;
            // 候选人在预约成功后才补发简历的场景：工单已存在、系统没有补挂附件的接口，
            // 若按普通 already_booked 收口，这份真简历会被静默丢弃（工单 438358 事故的
            // 第二段）。识别到"本轮新收到简历"时改走人工补传指引。
            const freshResumeThisTurn = getCurrentTurnResume(context);
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED,
              outcome: freshResumeThisTurn
                ? '候选人近期已有预约工单，跳过重复预约；本轮新收到的简历需人工补传到原工单'
                : '候选人近期已有预约工单，跳过重复预约',
              replyInstruction: freshResumeThisTurn
                ? '该候选人近期已成功预约过面试，不要重复提交预约，也不要再次调用本工具。' +
                  '但候选人本轮补发了简历文件，系统无法把简历补挂到已有工单上：请调用 ' +
                  'request_handoff(reasonCode="system_blocked")，reason 写明"候选人预约后补发简历，' +
                  `需人工将简历补传到工单 ${duplicateBooking.work_order_id}"。` +
                  '对候选人只说简历已收到、会帮他跟进，不要说简历已提交成功。'
                : '该候选人近期已成功预约过这个岗位，不要对同一岗位重复提交预约，也不要再次调用本工具。若候选人要改时间或取消，请调用 request_handoff(reasonCode="modify_appointment") 转人工改约；若候选人明确要报名另一个不同岗位，可以继续对新岗位走 precheck/booking。' +
                  '⚠️ 向候选人说明时只能说"系统显示近期已有一笔该岗位的报名记录"，' +
                  '**不得自行推断或声称**手机号相同、该号已报过名、是同一个人等具体原因——' +
                  '本工具只告诉你存在一笔既有工单（existingWorkOrderId），没有告诉你它属于谁、用的哪个手机号。' +
                  '候选人质疑时调 request_handoff 转人工核实，不要坚持解释。',
              details: {
                existingWorkOrderId: duplicateBooking.work_order_id,
                ...(freshResumeThisTurn
                  ? { pendingUploadResume: bookingUploadResume ?? freshResumeThisTurn }
                  : {}),
              },
            });
          }

          // 最后提交闸门：Agent 生成可能持续数分钟，期间候选人会补发或更正报名资料。
          // 真正调用海绵前检查本轮输入是否已过期；命中后不创建工单，交给渠道合并新消息 replay。
          if (context.runtime.hasNewerUserInput && (await context.runtime.hasNewerUserInput())) {
            logger.warn(
              `[booking] 提交前检测到候选人新消息，短路旧输入: chatId=${context.session.sessionId}, jobId=${jobId}`,
            );
            return markBookingFailed(context, {
              ...buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                outcome: '预约未提交（候选人有更新消息，当前入参已过期）',
                replyInstruction:
                  '候选人刚补充了新消息，当前报名资料已过期。runtime 会合并最新消息重新处理；' +
                  '本轮立即停止，不要回复候选人、不要重试 booking、不要调用其他工具。',
                details: { jobId },
              }),
              shortCircuited: true,
              staleInput: true,
              reasonCode: 'newer_user_input_pending',
            });
          }

          const result = await spongeService.bookInterview(
            {
              jobId,
              interviewTime,
              name,
              phone,
              age,
              genderId,
              operateType,
              avatar,
              householdRegisterProvinceId,
              height,
              weight,
              hasHealthCertificate,
              healthCertificateTypes,
              educationId,
              uploadResume: bookingUploadResume,
              customerLabelList: bookingCustomerLabelList,
              logId,
            },
            spongeTokenContext,
          );

          context.ledger.jobs.bookingSucceeded = result.success;

          if (!result.success) {
            void opsEventsRecorder.recordEvent({
              corpId: context.session.corpId,
              eventName: 'booking.failed',
              idempotencyKey: `${context.session.sessionId}:booking_fail:${jobId}:${interviewTime ?? 'wait_notice'}`,
              botImId: context.session.botImId,
              managerName: context.session.botUserId,
              userId: context.session.userId,
              chatId: context.session.sessionId,
              payload: {
                job_id: jobId,
                interview_time: interviewTime ?? null,
                reason: result.message ?? null,
              },
            });

            pauseUserHostingAsync(
              userHostingService,
              context.session.sessionId,
              `[自动暂停] 预约失败，已暂停托管: chatId=${context.session.sessionId}`,
            );
          } else {
            const workOrderId = result.workOrderId ?? null;

            // Path A: 预约成功 → 将高置信度候选人信息写入长期记忆 Profile。
            // 报名数据是候选人自主填写并经 precheck 校验的，是所有来源中置信度最高的。
            void longTermService
              .writeFromBooking(context.session.corpId, context.session.userId, {
                name,
                phone,
                age,
                gender: getSpongeGenderLabelById(genderId) ?? String(genderId),
              })
              .catch((err: unknown) => {
                logger.warn(
                  `[booking] writeFromBooking 失败，不影响主流程: ${err instanceof Error ? err.message : String(err)}`,
                );
              });

            // 预约信息挂候选人画像：active_booking 极简指针 + booking.succeeded 事件底账。
            // 不再写 recruitment_cases（已废弃，状态全部实时查海绵）。
            //
            // booking.succeeded 幂等键：优先用 workOrderId（跨 Bull 重试稳定）；海绵偶发「成功但
            // 未返回 workOrderId」（结构漂移）时回退会话级稳定键，确保成功事件仍照常记录，
            // 不因缺字段把整笔成功预约漏计（KPI undercount）。active_booking 指针本身依赖 workOrderId，
            // 仅在可用时写。
            const bookingSuccessKey =
              workOrderId != null
                ? String(workOrderId)
                : `${context.session.sessionId}:booking_success:${jobId}:${interviewTime ?? 'wait_notice'}`;

            if (workOrderId != null) {
              void longTermService
                .setActiveBooking(context.session.corpId, context.session.userId, workOrderId, {
                  job_id: jobId,
                })
                .catch((err: unknown) => {
                  logger.warn(
                    `[booking] setActiveBooking 失败，不影响主流程: ${err instanceof Error ? err.message : String(err)}`,
                  );
                });
            } else {
              logger.warn(
                '[booking] 预约成功但缺少 workOrderId，跳过 active_booking 指针写入（ops_events 仍照常记录）',
              );
            }

            void opsEventsRecorder.recordEvent({
              corpId: context.session.corpId,
              eventName: 'booking.succeeded',
              idempotencyKey: bookingSuccessKey,
              botImId: context.session.botImId,
              managerName: context.session.botUserId,
              userId: context.session.userId,
              chatId: context.session.sessionId,
              payload: {
                work_order_id: workOrderId,
                candidate_name: name,
                phone,
                // candidate_age / candidate_gender：booking 提交值是经业务校验的
                // ground truth。与 message_processing_records.memory_snapshot 里
                // 同 chat 的提取值 join，即可零标注成本计算逐字段提取准确率
                // （提取质量对账基线）。
                candidate_age: age,
                candidate_gender: getSpongeGenderLabelById(genderId) ?? String(genderId),
                brand_name: resolvedBrandName,
                store_name: resolvedStoreName,
                job_name: resolvedJobName,
                interview_time: interviewTime ?? null,
              },
            });
          }

          const toolResult = result.success
            ? {
                ...result,
                errorType: null,
                requestInfo,
                _outcome: '预约成功，可以告知候选人面试安排',
                // badcase yfrc6wb9：booking success 后回复未向候选人播报，候选人不知已报名，
                // 3 分钟后重复提交撞 already_booked。成功播报是硬约束，不是可选项。
                _replyInstruction:
                  '预约已成功提交。本轮回复**必须**明确向候选人确认报名成功，并按下方 _confirmedInterviewTimeHuman / 各 guide 字段复述面试安排；' +
                  '严禁不提报名结果、只回答候选人其他问题或静默。' +
                  (manualInterviewGroupHandling
                    ? '本岗位需要单独的面试群且只能由当前企微账号随后手动发送；预约成功后仍按既有规则调用 invite_to_group 发送兼职岗位信息群，' +
                      '最终回复必须带兼职群实际群名和用途，并明确它不是面试群；再按 _manualInterviewGroupGuide 说明面试群邀请会接着单独发送。' +
                      '全程使用“我”的口径，禁止出现工作人员、运营、人工、机器人或账号接管等身份切换表述。'
                    : ''),
                // 历史 badcase keciu6u6 / waugdoxa / 2za5e0ek：约面成功后 Agent 漏说具体时间点、漏教候选人到店脚本。
                // 这两个字段是工具事实，Agent 必须照实复述（在 Agent prompt 的"## 硬规则"段有强约束）。
                // 等通知岗位（无 interviewTime）没有时间点可复述、也没有到店环节，
                // 改为输出"面试官电话联系"话术指引。
                ...(interviewTime
                  ? /ai/i.test(interviewType ?? '')
                    ? {
                        _confirmedInterviewTimeHuman: formatInterviewTimeForReply(interviewTime),
                        _aiInterviewGuide:
                          '该岗位是 AI 面试，无需到店；请提醒候选人按面试通知里的入口和要求在线完成，不要发送到店报到或携带证件话术。' +
                          // badcase recvpYfDLkx4Fz：预约日期只是系统登记信息，AI 面试在通知时限内可提前完成，
                          // 候选人问"必须明天做吗/能提前吗"时不得按预约日咬死。
                          '预约的面试时间是系统登记时段，不是"到点开考"：候选人收到面试通知/面试码后在通知规定的时限内完成即可，一般可以提前做，具体以通知为准。',
                        _resultDisclaimer: '具体面试要求和结果以 AI 面试通知为准',
                      }
                    : onlineInterview
                      ? // badcase chat 6a5f3080：线上面试岗位（备注"群里发腾讯会议链接"）
                        // 也被无条件附带到店脚本，Agent 同轮既说线上又说到店，自相矛盾。
                        {
                          _confirmedInterviewTimeHuman: formatInterviewTimeForReply(interviewTime),
                          _onlineInterviewGuide:
                            '该岗位面试初始环节为线上/电话形式，本轮不需要到店；严禁发送"到店跟前台/店长说"类报到话术、严禁发送门店地址作为面试地点。' +
                            '请按 precheck 返回的 flowDescription / processRemark 照实告知候选人面试形式（如"面试官先电话沟通，合适的会通知线下门店面试"就照念，' +
                            '并明确提醒候选人：在接到电话/通知前不要自行去门店）。',
                          _resultDisclaimer: '具体面试安排和结果以线上面试通知为准',
                        }
                      : {
                          _confirmedInterviewTimeHuman: formatInterviewTimeForReply(interviewTime),
                          _onSiteScript: buildOnSiteScript({
                            candidateName: name,
                            jobName: resolvedJobName,
                          }),
                          _resultDisclaimer: '具体上岗时间和面试结果以门店现场告知为准',
                        }
                  : {
                      _confirmedInterviewTimeHuman:
                        '未指定面试时间：面试官会直接电话联系候选人确认',
                      _waitNoticeReplyGuide:
                        '该岗位不选面试时间。告知候选人报名资料已提交成功，面试官会直接打电话联系（请保持电话畅通、留意陌生来电）；严禁编造具体面试时间或到店时间。',
                      _resultDisclaimer: '具体面试安排以面试官电话沟通为准',
                    }),
                ...(manualInterviewGroupHandling
                  ? {
                      interviewGroupHandling: manualInterviewGroupHandling,
                      _manualInterviewGroupGuide: manualInterviewGroupHandling.candidateGuide,
                      sideEffect: {
                        kind: 'general_handoff' as const,
                        source: 'agent_tool' as const,
                        alertLabel: '预约成功待补发面试群',
                        reasonCode: 'interview_group_invite_required',
                        reason:
                          `预约已成功，岗位流程要求加入${
                            manualInterviewGroupHandling.groupNameHint ?? '面试群'
                          }后获取腾讯会议链接；Agent只能发送兼职岗位信息群，` +
                          '需使用当前企微账号手动补发面试群邀请。',
                        actionAdvice: `请立即使用当前企微账号给候选人补发${
                          manualInterviewGroupHandling.groupNameHint ?? '面试群'
                        }邀请；兼职岗位信息群由Agent自动发送，无需重复发送。`,
                        workOrderId: result.workOrderId ?? null,
                        jobId,
                        idempotencyKey:
                          `${context.session.sessionId}:interview_group_invite:` +
                          `${result.workOrderId ?? `${jobId}:${interviewTime ?? 'wait_notice'}`}`,
                        recordHandoff: true,
                      },
                    }
                  : {}),
              }
            : {
                ...result,
                ...buildToolError({
                  errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                  outcome: '预约失败',
                  replyInstruction:
                    '预约未成功。请以真人招募者口吻用一句话向候选人说明"我让同事确认一下，稍等"之类的衔接语，自主组织措辞；不要透露具体报错或接口细节，不要提及机器人/托管/系统/自动等字眼，也不要继续推进其他任务。',
                  // apiCode/apiMessage 透传海绵后端的拒绝原因，仅供观测落库（与 cancel/modify
                  // 同口径）。**只加在本分支**：它是全文件唯一走完 spongeService.bookInterview
                  // 之后的拒绝态；其余 5 处 BOOKING_REJECTED 是本地闸门（未调 precheck /
                  // nextAction 未就绪 / 姓名电话对不上等），压根没请求过海绵，天然无 apiCode。
                  // 于是 apiCode 有无本身即可区分「本地拦下」与「海绵拒绝」——2026-08-06 周报
                  // 里 43 次 booking.rejected 无法细分（名额满/归属冲突/年龄/口径矛盾），
                  // 正是因为这一跳没接上。
                  details: {
                    requestInfo,
                    apiCode: result.code,
                    apiMessage: result.message ?? null,
                  },
                }),
              };

          // 需要人工补发面试群时，toolResult.sideEffect 会在候选人回复完成投递后统一执行
          // 「暂停托管 + @对应负责人告警」。不再并发发送普通预约成功卡，避免同一预约
          // 出现两张内部通知、运营重复处理。其它预约沿用原成功/失败通知。
          if (!result.success || !manualInterviewGroupHandling) {
            void sendInterviewBookingNotification(
              {
                candidateName: name,
                contactName: context.session.contactName,
                phone,
                genderLabel,
                ageText,
                interviewTime: interviewTime ?? '等待通知（面试官电话联系）',
                interviewType,
                brandName: resolvedBrandName,
                storeName: resolvedStoreName,
                jobName: resolvedJobName,
                jobId,
                botUserName: context.session.botUserId,
                toolOutput: toolResult,
                botImId: context.session.botImId,
              },
              privateChatNotifier,
            );
          }

          return toolResult;
        } catch (err) {
          logger.error('预约面试失败', err);
          context.ledger.jobs.bookingSucceeded = false;

          // 幂等键与上面「result.success===false」路径保持一致（去掉 :err 后缀）：
          // 同一 (session, job, interviewTime) 预约无论走「海绵返回失败」还是「抛异常」，
          // 都共用同一 key，Bull 重试多次失败只计一次 booking.failed，不重复 +1。
          void opsEventsRecorder.recordEvent({
            corpId: context.session.corpId,
            eventName: 'booking.failed',
            idempotencyKey: `${context.session.sessionId}:booking_fail:${jobId}:${interviewTime ?? 'wait_notice'}`,
            botImId: context.session.botImId,
            managerName: context.session.botUserId,
            userId: context.session.userId,
            chatId: context.session.sessionId,
            payload: {
              job_id: jobId,
              interview_time: interviewTime ?? null,
              reason: err instanceof Error ? err.message : String(err),
            },
          });

          pauseUserHostingAsync(
            userHostingService,
            context.session.sessionId,
            `[自动暂停] 预约异常，已暂停托管: chatId=${context.session.sessionId}`,
          );

          const toolResult = {
            ...buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REQUEST_FAILED,
              outcome: '预约失败',
              replyInstruction:
                '预约未成功。请以真人招募者口吻用一句话向候选人说明"我让同事确认一下，稍等"之类的衔接语，自主组织措辞；不要透露具体报错或接口细节，不要提及机器人/托管/系统/自动等字眼，也不要继续推进其他任务。',
              details: {
                requestInfo,
                reason: err instanceof Error ? err.message : '未知错误',
              },
            }),
          };

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              contactName: context.session.contactName,
              phone,
              genderLabel,
              ageText,
              interviewTime: interviewTime ?? '等待通知（面试官电话联系）',
              interviewType,
              brandName,
              storeName,
              jobName,
              jobId,
              botUserName: context.session.botUserId,
              toolOutput: toolResult,
              botImId: context.session.botImId,
            },
            privateChatNotifier,
          );

          return toolResult;
        }
      },
    });
  };
}

function resolveStoreName(job: JobDetail): string | null {
  const storeInfo =
    job.basicInfo?.storeInfo && typeof job.basicInfo.storeInfo === 'object'
      ? (job.basicInfo.storeInfo as Record<string, unknown>)
      : null;
  return normalizeText(storeInfo?.storeName) || normalizeText(job.basicInfo?.storeName);
}

/**
 * 从岗位详情中解析面试方式的展示字符串（"AI面试" / "线下面试" 等）。
 *
 * Schema 假设（上游契约：supplier/entryUser 对岗位详情的约定）：
 *   job.interviewProcess 可能为 undefined / 任意对象；
 *   job.interviewProcess.firstInterview?.firstInterviewDesc?: string   —— 含 "ai"（大小写不敏感）一律归为 AI 面试
 *   job.interviewProcess.firstInterview?.firstInterviewWay?:  string   —— 兜底取原值（"线上面试"/"线下面试" 等）
 *
 * 这里没有用 Zod 做运行时校验，而是用 `Record<string, unknown>` 做最小防御 —— 是因为
 * 这个字段只用于通知展示（不会回写海绵），任一字段缺失/类型不符都静默退化为 undefined，
 * 不会影响预约主流程。如果上游契约扩字段（例如 firstInterview 再下挂一层），这里不会
 * 自动跟上，需要手动更新路径。
 */
export function resolveInterviewType(job: JobDetail): string | undefined {
  const interviewProcess =
    job.interviewProcess && typeof job.interviewProcess === 'object'
      ? (job.interviewProcess as Record<string, unknown>)
      : null;
  const firstInterview =
    interviewProcess?.firstInterview && typeof interviewProcess.firstInterview === 'object'
      ? (interviewProcess.firstInterview as Record<string, unknown>)
      : null;
  if (!firstInterview) return undefined;

  const desc = normalizeText(firstInterview.firstInterviewDesc);
  if (desc && /ai/i.test(desc)) return 'AI面试';

  const way = normalizeText(firstInterview.firstInterviewWay);
  return way ?? undefined;
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isResumeLabel(value: string): boolean {
  return /简历/.test(value);
}

function getResumeSupplementLabels(
  supplementDefinitions: SpongeInterviewSupplementDefinition[],
): string[] {
  return supplementDefinitions.map((definition) => definition.labelName).filter(isResumeLabel);
}

function isResumeRequiredByJob(
  job: JobDetail,
  supplementDefinitions: SpongeInterviewSupplementDefinition[],
): boolean {
  if (getResumeSupplementLabels(supplementDefinitions).length > 0) return true;

  const analysis = buildJobPolicyAnalysis(job);
  if (analysis.fieldGuidance.fieldSignals.some((signal) => signal.field === '简历附件')) {
    return true;
  }

  const policyText = collectStringValues({
    hiringRequirement: job.hiringRequirement,
    interviewProcess: job.interviewProcess,
  }).join('\n');
  if (/不需要.{0,6}简历|无需.{0,6}简历|免.{0,4}简历/.test(policyText)) return false;
  return /上传简历|简历附件|简历模板|简历.{0,8}审核|审核.{0,8}简历/.test(policyText);
}

function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 6 || value == null) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectStringValues(item, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      collectStringValues(item, depth + 1),
    );
  }
  return [];
}

/**
 * uploadResume 只有两种合法形态：http(s) URL（待上传的文件地址）或海绵 uploadAttachment
 * 返回的云存储 key（文件名形态，如 刘渔林_20260609135452_20260610095630.docx）。
 * 候选人回填模板时写在"简历附件："后的自由文字会经会话事实流入这里——若原样放行，
 * 会被当作云存储 key 提交给 entryUser，海绵侧简历直接打不开（工单 438358 事故）。
 */
function isLikelyCloudStorageKey(value: string): boolean {
  if (value.length > 200 || /[\s：，。；、！？（）]/u.test(value)) return false;
  return /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|webp|txt)$/i.test(value);
}

function normalizeResumeValue(value: unknown): string | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  return isHttpUrl(text) || isLikelyCloudStorageKey(text) ? text : undefined;
}

/** 本轮高置信识别出的简历（候选人当轮刚发的文件/链接），仅当前轮有效。 */
function getCurrentTurnResume(context: ToolBuildContext): string | undefined {
  return normalizeResumeValue(
    getRuleFactValue(context.ledger.facts.ruleFacts, 'interview_info.upload_resume', {
      minConfidence: 'high',
    }),
  );
}

function resolveUploadResume(uploadResume: unknown, context: ToolBuildContext): string | undefined {
  const explicit = normalizeResumeValue(uploadResume);
  if (explicit) return explicit;

  const sessionResume = normalizeResumeValue(
    context.archive.sessionFacts?.interview_info.upload_resume,
  );
  if (sessionResume) return sessionResume;

  return getCurrentTurnResume(context);
}

async function resolveUploadResumeForBooking(
  uploadResume: string | undefined,
  context: ToolBuildContext,
  spongeService: SpongeService,
): Promise<string | undefined> {
  if (!uploadResume) return undefined;
  if (!isHttpUrl(uploadResume)) {
    return isLikelyCloudStorageKey(uploadResume) ? uploadResume : undefined;
  }

  const uploaded = await spongeService.uploadAttachmentFromUrl(
    {
      fileUrl: uploadResume,
      fileName: resolveUploadResumeFileName(uploadResume, context),
    },
    buildSpongeTokenContext(context),
  );
  return uploaded.cloudStorageKey;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function resolveUploadResumeFileName(
  uploadResume: string,
  context: ToolBuildContext,
): string | undefined {
  const content = collectTextParts(context.turnInput.messages).join('\n');
  for (const match of content.matchAll(
    /\[文件消息\]\s*文件名\s*[：:]\s*([^；;\n\r]+)[；;]\s*文件地址\s*[：:]\s*([^；;\n\r]+)/gu,
  )) {
    const fileName = normalizeText(match[1]);
    const fileUrl = normalizeText(match[2]);
    if (fileName && fileUrl === uploadResume) return fileName;
  }
  return undefined;
}

function resolveCandidateIsStudentForBooking(context: ToolBuildContext): boolean | undefined {
  // 统一走共享识别器（只读候选人 user 消息、剥引用块/时间戳、子句级锚定）。
  // 不得对"全窗口拼接文本"做子串测试：Agent 模板"身份（学生还是社会人士）："
  // 自带"社会人士"子串，任何出现过该模板的会话都会被误判为非学生。
  const currentUserEntry = context.turnInput.currentUserMessage
    ? [{ role: 'user', content: context.turnInput.currentUserMessage }]
    : [];
  const latestIdentityEvidence = findLatestExplicitIdentityEvidence([
    ...(Array.isArray(context.turnInput.messages) ? context.turnInput.messages : []),
    ...currentUserEntry,
  ]);
  const latestIdentity = latestIdentityEvidence?.identity ?? null;
  if (latestIdentity === '学生') return true;
  if (latestIdentity === '社会人士') return false;

  const sessionIdentity = context.archive.sessionFacts?.interview_info?.is_student;
  if (typeof sessionIdentity === 'boolean') return sessionIdentity;
  return typeof context.archive.profile?.is_student === 'boolean'
    ? context.archive.profile.is_student
    : undefined;
}

function collectTextParts(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectTextParts(item, depth + 1));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [
      ...collectTextParts(record.text, depth + 1),
      ...collectTextParts(record.content, depth + 1),
    ];
  }
  return [];
}

function withBookingUploadResumeCustomerLabels(
  customerLabelList: InterviewBookingCustomerLabel[],
  uploadResume: string | undefined,
): InterviewBookingCustomerLabel[] {
  if (!uploadResume) return customerLabelList;
  return customerLabelList.map((label) =>
    /简历/.test(label.labelName) || /简历/.test(label.name)
      ? { ...label, value: uploadResume }
      : label,
  );
}

async function sendInterviewBookingNotification(
  bookingInfo: InterviewBookingNotificationInfo,
  privateChatNotifier: PrivateChatMonitorNotifierService,
): Promise<void> {
  try {
    await privateChatNotifier.notifyInterviewBookingResult(bookingInfo);
  } catch (error) {
    logger.error(`面试预约通知发送异常: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeAgeText(age: number): string {
  return `${age}岁`;
}
