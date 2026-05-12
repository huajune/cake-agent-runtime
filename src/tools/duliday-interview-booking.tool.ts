/**
 * DuLiDay 面试预约工具
 *
 * 为求职者预约面试，需要提供与海绵 supplier/entryUser 契约一致的字段。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import type { JobDetail } from '@sponge/sponge.types';
import type { RecruitmentCaseRecord } from '@biz/recruitment-case/entities/recruitment-case.entity';
import {
  getSpongeGenderLabelById,
  SPONGE_EDUCATION_MAPPING,
  SPONGE_GENDER_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING,
  SPONGE_OPERATE_TYPE_MAPPING,
} from '@sponge/sponge.enums';
import { extractInterviewSupplementDefinitions } from '@sponge/sponge-job.util';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { BookingService } from '@biz/message/services/booking.service';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import { ToolBuildContext, ToolBuilder } from '@shared-types/tool.types';
import { API_BOOKING_REQUIRED_PAYLOAD_FIELDS } from '@tools/duliday/job-booking.contract';
import { buildCustomerLabelList } from '@tools/duliday/interview-booking-customer-label.builder';
import { runBookingGuards } from '@tools/duliday/booking-guards.util';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('duliday_interview_booking');
const INTERVIEW_TIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function buildAlreadyBookedResult(activeCase: RecruitmentCaseRecord): Record<string, unknown> {
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED,
    outcome: '当前会话已存在面试预约，本次未重复提交',
    replyInstruction:
      '当前会话已有面试预约。请直接基于 currentBooking 里的时间、门店、岗位等信息回答候选人；不要说"重新约好了"。若候选人要求改期/取消，或反馈门店查不到预约、预约信息冲突，请调用 request_handoff 转人工处理。',
    details: {
      currentBooking: {
        bookingId: activeCase.booking_id,
        bookedAt: activeCase.booked_at,
        interviewTime: activeCase.interview_time,
        jobId: activeCase.job_id,
        jobName: activeCase.job_name,
        brandName: activeCase.brand_name,
        storeName: activeCase.store_name,
        status: activeCase.status,
      },
    },
  });
}

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
    .pauseUser(chatId)
    .then(() => {
      logger.log(successMessage);
    })
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? (error.stack ?? error.message) : String(error);
      logger.error(`[自动暂停] 暂停托管失败: chatId=${chatId}`, errorMessage);
    });
}

function recordBookingCountAsync(
  bookingService: BookingService,
  context: ToolBuildContext,
  booking: { brandName?: string; storeName?: string },
): void {
  void bookingService
    .incrementBookingCount({
      brandName: booking.brandName,
      storeName: booking.storeName,
      chatId: context.chatId ?? context.sessionId,
      userId: context.userId,
      userName: context.contactName,
      managerId: context.botUserId ?? context.botImId,
      managerName: context.botUserId,
    })
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? (error.stack ?? error.message) : String(error);
      logger.error(`[预约统计] 写入失败: chatId=${context.sessionId}`, errorMessage);
    });
}

const supplementAnswersSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe('岗位补充标签回答，key 必须是标签名，例如 爱好、身份。标准字段对应标签会自动回填');

const DESCRIPTION = `预约面试。真正调用面试预约接口，提交面试时间 + 候选人信息。入参必须与 supplier/entryUser 契约保持一致。

## 调用契约（必读）
本工具**完全信任 duliday_interview_precheck 的结论**：自身不再做时段窗口、报名截止、筛选答案、真实姓名等硬规则的二次校验。漏调 precheck 或不按 precheck 的 nextAction 行动，就会把不合规的候选人直接送进门店。所以在调本工具之前，必须满足以下全部条件：

1. **本轮已经调过 duliday_interview_precheck**，且 nextAction === "ready_to_book"。任何 collect_fields / confirm_date / date_unavailable 状态都不得直接进 booking。
2. **interviewTime 必须来自 precheck 返回的 bookableSlots**：只有 bookingAllowed=true 且带 interviewTime 的 slot 才能用；dateOnly=true / 00:00-00:00 / bookingAllowed=false 的 slot 必须由人工确认，禁止自动提交。"registrationDeadline / 报名截止"**绝不是面试时间**，严禁把它当作 interviewTime。
3. **screeningChecks 必须已经向候选人核对完**：candidate 命中任一 failSignal 就停止收资、走 invite_to_group / request_handoff，**绝不能带着不合格答案来调本工具**。
4. **nameFieldGuard.suspicious=true 时**：必须先向候选人补问真实姓名，拿到合规的真名再调本工具；不得把昵称/占位串当 name 提交。
5. **班次硬约束**（"做一休一/每周最多两天/只周末/不上夜班/下班后/六点才下班"等）与岗位 workTime 不重叠时，禁止进入 booking；先用 duliday_job_list(includeWorkTime=true) 校验或换岗位。

## 前置（其它流程性要求）
- 若系统提示中已存在 [当前预约信息]，说明本会话已有 active 面试预约；候选人追问面试时间/门店/岗位/预约状态时，直接基于 [当前预约信息] 回答，**严禁再次调用本工具**
- 候选人要求改期/取消、反馈门店查不到预约或预约信息冲突，或说已面试/面试通过/店长已联系/只能一家店/正在报到培训办入职时，不要再次调用本工具，按 request_handoff 的规则转人工处理
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
    .describe('面试时间，格式必须为 YYYY-MM-DD HH:mm:ss，例如 2026-04-20 14:00:00'),
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
  recruitmentCaseService: RecruitmentCaseService,
  bookingService: BookingService,
): ToolBuilder {
  return (context) => {
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
      }) => {
        logger.log(`预约面试: ${name}, jobId=${jobId}`);

        try {
          const activeCase = await recruitmentCaseService.getActiveOnboardFollowupCase({
            corpId: context.corpId,
            chatId: context.sessionId,
          });
          if (activeCase) {
            logger.warn(
              `检测到已存在 active 面试 case，跳过重复预约: chatId=${context.sessionId}, caseId=${activeCase.id}`,
            );
            return markBookingFailed(context, buildAlreadyBookedResult(activeCase));
          }
        } catch (caseLookupError: unknown) {
          const message =
            caseLookupError instanceof Error ? caseLookupError.message : String(caseLookupError);
          logger.warn(`查询 active 面试 case 失败，继续执行预约流程: ${message}`);
        }

        const missingFields = [
          { field: 'jobId', value: jobId },
          { field: 'interviewTime', value: interviewTime },
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

        if (!INTERVIEW_TIME_REGEX.test(interviewTime)) {
          return markBookingFailed(
            context,
            buildToolError({
              errorType: TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME,
              outcome: '预约失败（interviewTime 格式错误）',
              replyInstruction:
                'interviewTime 必须为 YYYY-MM-DD HH:mm:ss 格式。先调用 duliday_interview_precheck 拿到合法 slot 再 重新调本工具，禁止凭印象拼接时间。',
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
          uploadResume,
          supplementAnswers,
          logId,
        };

        try {
          const { jobs } = await spongeService.fetchJobs({
            jobIdList: [jobId],
            pageNum: 1,
            pageSize: 1,
            options: {
              includeBasicInfo: true,
              includeInterviewProcess: true,
            },
          });

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

          // Defense-in-depth: 在调 sponge bookInterview 之前再跑一次 precheck 已经做过的
          // 三类硬规则校验（真名 / 时段 / 筛选答案）。LLM 偶发会跳过 precheck 直接调本工具，
          // 这里作为 server-side 兜底——详见 booking-guards.util.ts。
          const guardFailure = runBookingGuards({ job, name, interviewTime, supplementAnswers });
          if (guardFailure) {
            return markBookingFailed(context, guardFailure);
          }

          const customerLabelResolution = buildCustomerLabelList({
            supplementDefinitions: extractInterviewSupplementDefinitions(job),
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
            uploadResume,
            supplementAnswers,
          });

          if (customerLabelResolution.success === false) {
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
                  '岗位补充标签未填齐或取值非法。按 missingSupplementLabels / invalidSupplementLabels 列出的字段名向候选人补问；' +
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
            uploadResume,
            customerLabelList: customerLabelResolution.customerLabelList,
            supplementAnswers,
            logId,
          };

          const result = await spongeService.bookInterview({
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
            customerLabelList: customerLabelResolution.customerLabelList,
            logId,
          });

          context.bookingSucceeded = result.success;

          if (!result.success) {
            pauseUserHostingAsync(
              userHostingService,
              context.sessionId,
              `[自动暂停] 预约失败，已暂停托管: chatId=${context.sessionId}`,
            );
          } else {
            const resultRecord = result as unknown as Record<string, unknown>;
            const bookingId =
              typeof resultRecord.booking_id === 'string' && resultRecord.booking_id.trim()
                ? resultRecord.booking_id.trim()
                : null;

            recordBookingCountAsync(bookingService, context, {
              brandName: resolvedBrandName,
              storeName: resolvedStoreName,
            });

            void recruitmentCaseService
              .openOnBookingSuccess({
                corpId: context.corpId,
                chatId: context.sessionId,
                userId: context.userId,
                snapshot: {
                  bookingId,
                  bookedAt: new Date().toISOString(),
                  interviewTime,
                  jobId,
                  jobName: resolvedJobName,
                  brandName: resolvedBrandName,
                  storeName: resolvedStoreName,
                  botImId: context.botImId,
                  metadata: {
                    tool: 'duliday_interview_booking',
                  },
                },
              })
              .catch((caseError) => {
                logger.error('写入 recruitmentCase 失败', caseError);
              });
          }

          const toolResult = result.success
            ? {
                ...result,
                errorType: null,
                requestInfo,
                _outcome: '预约成功，可以告知候选人面试安排',
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
              interviewTime,
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
              interviewTime,
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
