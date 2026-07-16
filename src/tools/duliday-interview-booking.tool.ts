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
  getSpongeProvinceNameById,
} from '@sponge/sponge.enums';
import {
  extractInterviewSupplementDefinitions,
  type SpongeInterviewSupplementDefinition,
} from '@sponge/sponge-job.util';
import { buildSpongeTokenContext } from '@tools/utils/sponge-token-context.util';
import { findLatestExplicitIdentityEvidence } from '@tools/shared/identity-statement.util';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import { LongTermService } from '@memory/services/long-term.service';
import type { ActiveBooking } from '@memory/types/long-term.types';
import { OpsEventsRecorderService } from '@biz/ops-events/services/ops-events-recorder.service';
import { ToolBuildContext, ToolBuilder } from '@shared-types/tool.types';
import { API_BOOKING_REQUIRED_PAYLOAD_FIELDS } from '@tools/duliday/booking/job-booking.contract';
import { buildCustomerLabelList } from '@tools/duliday/booking/interview-booking-customer-label.builder';
import { runBookingGuards } from '@tools/duliday/booking/booking-guards.util';
import {
  buildOnSiteScript,
  formatInterviewTimeForReply,
} from '@tools/duliday/booking/booking-reply-format.util';
import { buildJobPolicyAnalysis, isWaitNoticeInterview } from '@tools/utils/job-policy-parser';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { evaluateBookingNameGate } from '@tools/shared/precheck-core';
import { unwrapHighConfidenceValue } from '@memory/facts/high-confidence-facts';

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
  context.bookingSucceeded = false;
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

function isRecentBooking(booking: ActiveBooking, now = Date.now()): boolean {
  const linkedAtMs = Date.parse(booking.linked_at);
  return Number.isFinite(linkedAtMs) && now - linkedAtMs < BOOKING_DEDUP_WINDOW_MS;
}

function isSameBookingTarget(booking: ActiveBooking, jobId: number): boolean {
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
  if (context.bookingCandidateFacts === undefined) return null;

  const facts = context.bookingCandidateFacts;
  const missingEvidenceFields: string[] = [];
  const conflictingFields: string[] = [];
  const checks: Array<{ field: string; expected: unknown; actual: unknown; required: boolean }> = [
    { field: '姓名', expected: facts?.name, actual: payload.name, required: true },
    { field: '联系电话', expected: facts?.phone, actual: payload.phone, required: true },
    { field: '年龄', expected: facts?.age, actual: payload.age, required: true },
    {
      field: '性别',
      expected: facts?.gender_source === 'candidate' ? facts.gender : null,
      actual: getSpongeGenderLabelById(payload.genderId),
      required: true,
    },
    {
      field: '学历',
      expected: facts?.education,
      actual: payload.educationId == null ? null : SPONGE_EDUCATION_MAPPING[payload.educationId],
      required: payload.educationId != null,
    },
    {
      field: '户籍省份',
      expected: facts?.household_register_province,
      actual:
        payload.householdRegisterProvinceId == null
          ? null
          : getSpongeProvinceNameById(payload.householdRegisterProvinceId),
      required: payload.householdRegisterProvinceId != null,
    },
    {
      field: '身高',
      expected: facts?.height,
      actual: payload.height,
      required: payload.height != null,
    },
    {
      field: '体重',
      expected: facts?.weight,
      actual: payload.weight,
      required: payload.weight != null,
    },
    {
      field: '健康证情况',
      expected: facts?.has_health_certificate,
      actual:
        payload.hasHealthCertificate == null
          ? null
          : SPONGE_HEALTH_CERTIFICATE_MAPPING[payload.hasHealthCertificate],
      required: payload.hasHealthCertificate != null,
    },
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
  .describe('岗位补充标签回答，key 必须是标签名，例如 爱好、身份。标准字段对应标签会自动回填');

const DESCRIPTION = `预约面试。真正调用面试预约接口，提交面试时间 + 候选人信息。入参必须与 supplier/entryUser 契约保持一致。

## 调用契约（必读）
本工具要求先完成 duliday_interview_precheck，并会在真实预约前对关键硬规则做服务端二次校验。漏调 precheck 或不按 precheck 的 nextAction 行动，会被直接拒绝。所以在调本工具之前，必须满足以下全部条件：

1. **本轮已经调过 duliday_interview_precheck**，且 nextAction === "ready_to_book"。任何 collect_fields / confirm_date / date_unavailable 状态都不得直接进 booking。**必须把本轮 precheck 返回的 nextAction + bookingChecklist.missingFields.length 原样填入入参 prechecked 字段**——后端会硬校验，缺该字段或 nextAction ≠ ready_to_book 或 missingFieldsCount > 0 直接拒，不会调真实预约接口。
2. **interviewTime 必须来自 precheck 返回的 bookableSlots**：只有 bookingAllowed=true 且带 interviewTime 的 slot 才能用；dateOnly=true / 00:00-00:00 / bookingAllowed=false 的 slot 必须由人工确认，禁止自动提交。"registrationDeadline / 报名截止"**绝不是面试时间**，严禁把它当作 interviewTime。**例外**：precheck 返回 interview.interviewTimeMode === "wait_notice"（岗位未配置面试时段，面试官电话联系）时，**不要传 interviewTime**，严禁自己编一个时间填进来。
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
        '其余岗位必填，且必须来自 precheck bookableSlots 中 bookingAllowed=true 的 slot。',
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
        '漏填、nextAction !== "ready_to_book" 或 missingFieldsCount > 0 时，booking 工具直接返回 BOOKING_REJECTED，不会调 sponge API。' +
        '字段技术上可选只是为了让 schema 不卡校验、缺失时能走友好错误返回（带 replyInstruction），业务语义上仍必填——' +
        '如果本轮没调 precheck，**不要瞎填**，直接漏掉，工具会回错让你先去调 precheck。',
    ),
});

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
      }) => {
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
        if (context.isRecalledJobId && !context.isRecalledJobId(jobId)) {
          return markBookingFailed(context, {
            ...buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_JOB_NOT_PROVIDED,
              outcome: '预约拦截（jobId 无召回出处）',
              replyInstruction:
                'runtime 已短路本轮，禁止继续生成回复或调用其他工具；该会话需要人工确认 jobId 来源。' +
                '本会话还没有通过 duliday_job_list 召回过任何岗位，当前 jobId 没有合法来源，禁止凭空 booking。' +
                '先调 duliday_job_list 召回岗位拿真实 jobId，再走 duliday_interview_precheck，nextAction=ready_to_book 后才能调本工具。',
              details: { jobId },
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

        // HC-2 姓名权威闸门（booking 侧 defense-in-depth，负向证据）：name 在原文里仅以
        // "我是X"打招呼语昵称出现时拒——这是 runBookingGuards.checkRealName 纯形态校验拦不住的
        // 缺口（2-4 字昵称形态合法但只是微信打招呼昵称）。先确认真名再约，不得拿昵称下真预约。
        const nameGate = evaluateBookingNameGate(name, context.messages ?? []);
        if (nameGate.decision === 'reject_collect') {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS,
              outcome: '预约失败（姓名疑似打招呼语昵称）',
              replyInstruction:
                `${nameGate.reason}。请用"门店登记需要本名"等自然话术先向候选人确认真实姓名，` +
                '拿到真名后再调 duliday_interview_precheck/本工具；禁止把微信昵称或"我是XX"里的昵称当姓名提交。',
              details: { suspiciousName: name },
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

        // 报名字段权威性闸门：最终 API payload 必须能由当前轮确定性自报或高置信会话事实
        // 逐项解释。模型从 prompt 复制的 medium/llm 历史值既不能补缺，也不能覆盖最新自报。
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
            `[booking] 候选人字段权威性校验拒绝: chatId=${context.sessionId}, ` +
              `missing=${authorityFailure.missingEvidenceFields.join('|') || '-'}, ` +
              `conflict=${authorityFailure.conflictingFields.join('|') || '-'}`,
          );
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
              outcome: '预约失败（报名字段缺少候选人明确确认或与最新自报冲突）',
              replyInstruction:
                '报名资料不能使用低置信历史记忆。按 missingEvidenceFields 补问候选人，' +
                '按 conflictingFields 采用候选人最新自报后重新 precheck；在字段确认完成前禁止 booking。',
              details: { ...authorityFailure },
            }),
          );
        }

        const resolvedUploadResume = resolveUploadResume(uploadResume, context);
        const genderLabel = getSpongeGenderLabelById(genderId) ?? undefined;
        const ageText = normalizeAgeText(age);
        let interviewType: string | undefined;
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
            return markBookingFailed(
              context,
              buildToolError({
                errorType: TOOL_ERROR_TYPES.BOOKING_JOB_NOT_FOUND,
                outcome: '预约失败（未找到岗位）',
                replyInstruction:
                  '当前 jobId 对应的岗位查不到。用招募者口吻安抚"我帮你查下这家店"，' +
                  '调用 duliday_job_list 重新核对岗位状态；不要透露 jobId 或接口细节。',
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
          // 三类硬规则校验（真名 / 时段 / 筛选答案）。LLM 偶发会跳过 precheck 直接调本工具，
          // 这里作为 server-side 兜底——详见 booking-guards.util.ts。
          const guardFailure = runBookingGuards({
            job,
            name,
            interviewTime,
            supplementAnswers,
            candidateGenderId: genderId,
            candidateHasHealthCertificate: hasHealthCertificate,
            candidateHealthCertificateFact:
              unwrapHighConfidenceValue(
                context.highConfidenceFacts?.interview_info.has_health_certificate,
              ) ?? context.sessionFacts?.interview_info.has_health_certificate,
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

          // 提交前软查重：recruitment_cases 废弃后，重复预约主要靠海绵约束 + active_booking
          // 指针体现。这里补一道本地兜底——仅当候选人窗口内已有「同岗位」active_booking
          // 时拦截，避免 Bull 重试 / Agent 同会话重复调用生成第二张同岗位工单。
          // 不同岗位不拦截，支持候选人同时报名多个岗位。
          const activeBookings = await longTermService
            .getActiveBookings(context.corpId, context.userId)
            .catch(() => null);
          const recentSameJobBooking = (activeBookings ?? []).find(
            (booking) => isRecentBooking(booking) && isSameBookingTarget(booking, jobId),
          );
          // 软查重按「企微联系人 + 岗位」定位，但一个企微号可能先后给不同的人报同一岗位
          // （工单 448367→448402 事故：罗欣宇约成功后，同会话给许颖约同岗位被误判重复）。
          // 命中指针后再用 work_order_id 反查工单上的手机号：手机号不同 = 不同候选人，放行；
          // 只有同手机号（或查不到工单手机号时保守处理）才判定为真正的重复提交。
          let duplicateBooking = recentSameJobBooking;
          if (recentSameJobBooking?.work_order_id != null) {
            const existingWorkOrder = await spongeService
              .getCachedWorkOrderById(recentSameJobBooking.work_order_id, spongeTokenContext)
              .catch(() => null);
            const existingPhone = normalizePhoneDigits(existingWorkOrder?.phone);
            const currentPhone = normalizePhoneDigits(phone);
            if (existingPhone && currentPhone && existingPhone !== currentPhone) {
              logger.log(
                `[booking] 近期同岗位 active_booking 手机号与本次不同，判定为不同候选人，放行: ` +
                  `chatId=${context.sessionId}, jobId=${jobId}, workOrderId=${recentSameJobBooking.work_order_id}`,
              );
              duplicateBooking = undefined;
            }
          }
          if (duplicateBooking?.work_order_id != null) {
            logger.warn(
              `[booking] 命中近期同岗位 active_booking 软查重，跳过重复提交: chatId=${context.sessionId}, jobId=${jobId}, workOrderId=${duplicateBooking.work_order_id}`,
            );
            // 候选人确已预约 → bookingSucceeded 置 true（不阻断后续拉群等流程）。
            context.bookingSucceeded = true;
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
                : '该候选人近期已成功预约过这个岗位，不要对同一岗位重复提交预约，也不要再次调用本工具。若候选人要改时间或取消，请调用 request_handoff(reasonCode="modify_appointment") 转人工改约；若候选人明确要报名另一个不同岗位，可以继续对新岗位走 precheck/booking。',
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
          if (context.hasNewerUserInput && (await context.hasNewerUserInput())) {
            logger.warn(
              `[booking] 提交前检测到候选人新消息，短路旧输入: chatId=${context.sessionId}, jobId=${jobId}`,
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

          context.bookingSucceeded = result.success;

          if (!result.success) {
            void opsEventsRecorder.recordEvent({
              corpId: context.corpId,
              eventName: 'booking.failed',
              idempotencyKey: `${context.sessionId}:booking_fail:${jobId}:${interviewTime ?? 'wait_notice'}`,
              botImId: context.botImId,
              managerName: context.botUserId,
              userId: context.userId,
              chatId: context.sessionId,
              payload: {
                job_id: jobId,
                interview_time: interviewTime ?? null,
                reason: result.message ?? null,
              },
            });

            pauseUserHostingAsync(
              userHostingService,
              context.sessionId,
              `[自动暂停] 预约失败，已暂停托管: chatId=${context.sessionId}`,
            );
          } else {
            const workOrderId = result.workOrderId ?? null;

            // Path A: 预约成功 → 将高置信度候选人信息写入长期记忆 Profile。
            // 报名数据是候选人自主填写并经 precheck 校验的，是所有来源中置信度最高的。
            void longTermService
              .writeFromBooking(context.corpId, context.userId, {
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
                : `${context.sessionId}:booking_success:${jobId}:${interviewTime ?? 'wait_notice'}`;

            if (workOrderId != null) {
              void longTermService
                .setActiveBooking(context.corpId, context.userId, workOrderId, {
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
              corpId: context.corpId,
              eventName: 'booking.succeeded',
              idempotencyKey: bookingSuccessKey,
              botImId: context.botImId,
              managerName: context.botUserId,
              userId: context.userId,
              chatId: context.sessionId,
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
                // 历史 badcase keciu6u6 / waugdoxa / 2za5e0ek：约面成功后 Agent 漏说具体时间点、漏教候选人到店脚本。
                // 这两个字段是工具事实，Agent 必须照实复述（在 Agent prompt 的"## 硬规则"段有强约束）。
                // 等通知岗位（无 interviewTime）没有时间点可复述、也没有到店环节，
                // 改为输出"面试官电话联系"话术指引。
                ...(interviewTime
                  ? /ai/i.test(interviewType ?? '')
                    ? {
                        _confirmedInterviewTimeHuman: formatInterviewTimeForReply(interviewTime),
                        _aiInterviewGuide:
                          '该岗位是 AI 面试，无需到店；请提醒候选人按面试通知里的入口和要求在线完成，不要发送到店报到或携带证件话术。',
                        _resultDisclaimer: '具体面试要求和结果以 AI 面试通知为准',
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
              }
            : {
                ...result,
                ...buildToolError({
                  errorType: TOOL_ERROR_TYPES.BOOKING_REJECTED,
                  outcome: '预约失败',
                  replyInstruction:
                    '预约未成功。请以真人招募者口吻用一句话向候选人说明"我让同事确认一下，稍等"之类的衔接语，自主组织措辞；不要透露具体报错或接口细节，不要提及机器人/托管/系统/自动等字眼，也不要继续推进其他任务。',
                  details: { requestInfo },
                }),
              };

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              contactName: context.contactName,
              phone,
              genderLabel,
              ageText,
              interviewTime: interviewTime ?? '等待通知（面试官电话联系）',
              interviewType,
              brandName: resolvedBrandName,
              storeName: resolvedStoreName,
              jobName: resolvedJobName,
              jobId,
              botUserName: context.botUserId,
              toolOutput: toolResult,
              botImId: context.botImId,
            },
            privateChatNotifier,
          );

          return toolResult;
        } catch (err) {
          logger.error('预约面试失败', err);
          context.bookingSucceeded = false;

          // 幂等键与上面「result.success===false」路径保持一致（去掉 :err 后缀）：
          // 同一 (session, job, interviewTime) 预约无论走「海绵返回失败」还是「抛异常」，
          // 都共用同一 key，Bull 重试多次失败只计一次 booking.failed，不重复 +1。
          void opsEventsRecorder.recordEvent({
            corpId: context.corpId,
            eventName: 'booking.failed',
            idempotencyKey: `${context.sessionId}:booking_fail:${jobId}:${interviewTime ?? 'wait_notice'}`,
            botImId: context.botImId,
            managerName: context.botUserId,
            userId: context.userId,
            chatId: context.sessionId,
            payload: {
              job_id: jobId,
              interview_time: interviewTime ?? null,
              reason: err instanceof Error ? err.message : String(err),
            },
          });

          pauseUserHostingAsync(
            userHostingService,
            context.sessionId,
            `[自动暂停] 预约异常，已暂停托管: chatId=${context.sessionId}`,
          );

          const toolResult = buildToolError({
            errorType: TOOL_ERROR_TYPES.BOOKING_REQUEST_FAILED,
            outcome: '预约失败',
            replyInstruction:
              '预约未成功。请以真人招募者口吻用一句话向候选人说明"我让同事确认一下，稍等"之类的衔接语，自主组织措辞；不要透露具体报错或接口细节，不要提及机器人/托管/系统/自动等字眼，也不要继续推进其他任务。',
            details: {
              requestInfo,
              reason: err instanceof Error ? err.message : '未知错误',
            },
          });

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              contactName: context.contactName,
              phone,
              genderLabel,
              ageText,
              interviewTime: interviewTime ?? '等待通知（面试官电话联系）',
              interviewType,
              brandName,
              storeName,
              jobName,
              jobId,
              botUserName: context.botUserId,
              toolOutput: toolResult,
              botImId: context.botImId,
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
  const currentTurnResume = context.highConfidenceFacts?.interview_info.upload_resume;
  if (currentTurnResume && typeof currentTurnResume === 'object' && 'value' in currentTurnResume) {
    return normalizeResumeValue(currentTurnResume.value);
  }
  return undefined;
}

function resolveUploadResume(uploadResume: unknown, context: ToolBuildContext): string | undefined {
  const explicit = normalizeResumeValue(uploadResume);
  if (explicit) return explicit;

  const sessionResume = normalizeResumeValue(context.sessionFacts?.interview_info.upload_resume);
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
  const content = collectTextParts(context.messages).join('\n');
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
  // 旧实现对"全窗口拼接文本"做子串测试，Agent 模板"身份（学生还是社会人士）："
  // 自带"社会人士"子串，任何出现过该模板的会话都会被误判为非学生。
  const currentUserEntry = context.currentUserMessage
    ? [{ role: 'user', content: context.currentUserMessage }]
    : [];
  const latestIdentityEvidence = findLatestExplicitIdentityEvidence([
    ...(Array.isArray(context.messages) ? context.messages : []),
    ...currentUserEntry,
  ]);
  const latestIdentity = latestIdentityEvidence?.identity ?? null;
  if (latestIdentity === '学生') return true;
  if (latestIdentity === '社会人士') return false;

  const sessionIdentity = context.sessionFacts?.interview_info?.is_student;
  if (typeof sessionIdentity === 'boolean') return sessionIdentity;
  return typeof context.profile?.is_student === 'boolean' ? context.profile.is_student : undefined;
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
