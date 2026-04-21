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
  getSpongeEducationLabelById,
  getSpongeGenderLabelById,
  getSpongeHealthCertificateLabelById,
  getSpongeHealthCertificateTypeLabels,
  getSpongeProvinceNameById,
  SPONGE_EDUCATION_MAPPING,
  SPONGE_GENDER_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_MAPPING,
  SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING,
  SPONGE_OPERATE_TYPE_MAPPING,
} from '@sponge/sponge.enums';
import {
  extractInterviewSupplementDefinitions,
  SpongeInterviewSupplementDefinition,
} from '@sponge/sponge-job.util';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { RecruitmentCaseService } from '@biz/recruitment-case/services/recruitment-case.service';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import { ToolBuildContext, ToolBuilder } from '@shared-types/tool.types';
import { API_BOOKING_REQUIRED_PAYLOAD_FIELDS } from '@tools/duliday/job-booking.contract';

const logger = new Logger('duliday_interview_booking');
const INTERVIEW_TIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const supplementAnswersSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe('岗位补充标签回答，key 必须是标签名，例如 爱好、身份。标准字段对应标签会自动回填');

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
  toolOutput: Record<string, unknown>;
  botImId?: string;
}

export function buildInterviewBookingTool(
  spongeService: SpongeService,
  privateChatNotifier: PrivateChatMonitorNotifierService,
  userHostingService: UserHostingService,
  recruitmentCaseService: RecruitmentCaseService,
): ToolBuilder {
  return (context) => {
    return tool({
      description: `预约面试。真正调用面试预约接口，提交面试时间 + 候选人信息。入参必须与 supplier/entryUser 契约保持一致。

## 前置
- 需要 jobId。优先从 [会话记忆] 的「当前焦点岗位」中获取；若没有，再从「最近已展示岗位」或「上轮候选岗位池」中获取，或调用 duliday_job_list 查询
- 涉及"今天能不能约"、"哪天能约"、"当前岗位还要补什么资料"时，先调用 duliday_interview_precheck，再决定是否进入预约
- 在调用前，先按当前阶段策略和 duliday_job_list 的结果核对硬条件、面试形式和明确时间
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
- 失败时严禁原样复读 _replyInstruction、严禁透露接口报错/技术细节、严禁继续推进其他任务`,
      inputSchema: z.object({
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
      }),
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
          return {
            success: false,
            errorType: 'missing_fields',
            missingFields,
            requiredPayloadFields: [...API_BOOKING_REQUIRED_PAYLOAD_FIELDS],
            error: `缺少预约接口必填字段：${missingFields.join('、')}`,
          };
        }

        if (!INTERVIEW_TIME_REGEX.test(interviewTime)) {
          return {
            success: false,
            errorType: 'invalid_interview_time',
            error: 'interviewTime 格式错误，请使用 YYYY-MM-DD HH:mm:ss',
          };
        }

        if (!Number.isInteger(age) || age < 10 || age > 100) {
          return {
            success: false,
            errorType: 'invalid_age',
            error: 'age 必须是 10-100 之间的整数',
          };
        }

        if (!(genderId in SPONGE_GENDER_MAPPING)) {
          return {
            success: false,
            errorType: 'invalid_gender_id',
            error: 'genderId 仅支持 1=男、2=女',
          };
        }

        if (!(operateType in SPONGE_OPERATE_TYPE_MAPPING)) {
          return {
            success: false,
            errorType: 'invalid_operate_type',
            error: 'operateType 仅支持 1-6，ai导入请传 6',
          };
        }

        if (educationId != null && !(educationId in SPONGE_EDUCATION_MAPPING)) {
          return {
            success: false,
            errorType: 'invalid_education_id',
            availableEducationIds: SPONGE_EDUCATION_MAPPING,
            error: `educationId 无效：${educationId}`,
          };
        }

        if (
          hasHealthCertificate != null &&
          !(hasHealthCertificate in SPONGE_HEALTH_CERTIFICATE_MAPPING)
        ) {
          return {
            success: false,
            errorType: 'invalid_health_certificate',
            error: 'hasHealthCertificate 仅支持 1=有、2=无但接受办理、3=无且不接受办理',
          };
        }

        if (
          healthCertificateTypes?.some(
            (value) =>
              !Number.isInteger(value) || !(value in SPONGE_HEALTH_CERTIFICATE_TYPE_MAPPING),
          )
        ) {
          return {
            success: false,
            errorType: 'invalid_health_certificate_types',
            error: 'healthCertificateTypes 仅支持 1=食品健康证、2=零售健康证、3=其他健康证',
          };
        }

        const genderLabel = getSpongeGenderLabelById(genderId) ?? undefined;
        const ageText = normalizeAgeText(age);
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
            return {
              success: false,
              errorType: 'job_not_found',
              error: `未找到 jobId=${jobId} 对应的岗位，无法回填 customerLabelList`,
            };
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
            return {
              success: false,
              errorType: customerLabelResolution.errorType,
              error: customerLabelResolution.error,
              missingSupplementLabels: customerLabelResolution.missingSupplementLabels,
              invalidSupplementLabels: customerLabelResolution.invalidSupplementLabels,
              customerLabelDefinitions: customerLabelResolution.customerLabelDefinitions,
            };
          }

          const resolvedBrandName =
            brandName || normalizeText(job.basicInfo.brandName) || undefined;
          const resolvedStoreName = storeName || resolveStoreName(job) || undefined;
          const resolvedJobName =
            jobName ||
            normalizeText(job.basicInfo.jobName) ||
            normalizeText(job.basicInfo.jobNickName) ||
            undefined;
          requestInfo = {
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
            void userHostingService.pauseUser(context.sessionId).then(() => {
              logger.log(`[自动暂停] 预约失败，已暂停托管: chatId=${context.sessionId}`);
            });
          } else {
            const resultRecord = result as unknown as Record<string, unknown>;
            const bookingId =
              typeof resultRecord.booking_id === 'string' && resultRecord.booking_id.trim()
                ? resultRecord.booking_id.trim()
                : null;

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

          const toolResult = {
            ...result,
            errorType: result.success ? null : 'booking_rejected',
            requestInfo,
            ...(result.success
              ? { _outcome: '预约成功，可以告知候选人面试安排' }
              : {
                  _outcome: '预约失败',
                  _replyInstruction:
                    '预约未成功。请以真人招募者口吻用一句话向候选人说明“我让同事确认一下，稍等”之类的衔接语，自主组织措辞；不要透露具体报错或接口细节，不要提及机器人/托管/系统/自动等字眼，也不要继续推进其他任务。',
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

          void userHostingService.pauseUser(context.sessionId).then(() => {
            logger.log(`[自动暂停] 预约异常，已暂停托管: chatId=${context.sessionId}`);
          });

          const toolResult = {
            success: false,
            errorType: 'booking_request_failed',
            error: `预约面试失败: ${err instanceof Error ? err.message : '未知错误'}`,
            requestInfo,
            _outcome: '预约失败',
            _replyInstruction:
              '预约未成功。请以真人招募者口吻用一句话向候选人说明“我让同事确认一下，稍等”之类的衔接语，自主组织措辞；不要透露具体报错或接口细节，不要提及机器人/托管/系统/自动等字眼，也不要继续推进其他任务。',
          };

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              contactName: context.contactName,
              phone,
              genderLabel,
              ageText,
              interviewTime,
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

export interface BuildCustomerLabelListParams {
  supplementDefinitions: SpongeInterviewSupplementDefinition[];
  context: ToolBuildContext;
  name: string;
  phone: string;
  age: number;
  genderId: number;
  interviewTime: string;
  householdRegisterProvinceId?: number;
  height?: number;
  weight?: number;
  hasHealthCertificate?: number;
  healthCertificateTypes?: number[];
  educationId?: number;
  uploadResume?: string;
  supplementAnswers?: Record<string, string>;
}

export type BuildCustomerLabelListResult =
  | {
      success: true;
      customerLabelList: InterviewBookingCustomerLabel[];
      customerLabelDefinitions: SpongeInterviewSupplementDefinition[];
    }
  | {
      success: false;
      errorType: 'missing_customer_label_values' | 'invalid_customer_label_values';
      error: string;
      missingSupplementLabels?: string[];
      invalidSupplementLabels?: string[];
      customerLabelDefinitions: SpongeInterviewSupplementDefinition[];
    };

export function buildCustomerLabelList(
  params: BuildCustomerLabelListParams,
): BuildCustomerLabelListResult {
  const definitions = params.supplementDefinitions;
  if (definitions.length === 0) {
    return {
      success: true,
      customerLabelList: [],
      customerLabelDefinitions: [],
    };
  }

  const customerLabelList: InterviewBookingCustomerLabel[] = [];
  const missingSupplementLabels: string[] = [];
  const invalidSupplementLabels: string[] = [];

  for (const definition of definitions) {
    const value = resolveCustomerLabelValue(definition.labelName, params);
    if (!value) {
      missingSupplementLabels.push(definition.labelName);
      continue;
    }
    if (value.length > 51) {
      invalidSupplementLabels.push(definition.labelName);
      continue;
    }

    customerLabelList.push({
      labelId: definition.labelId,
      labelName: definition.labelName,
      name: definition.labelName,
      value,
    });
  }

  if (missingSupplementLabels.length > 0) {
    return {
      success: false,
      errorType: 'missing_customer_label_values',
      error: `岗位补充标签缺少取值：${missingSupplementLabels.join('、')}`,
      missingSupplementLabels,
      customerLabelDefinitions: definitions,
    };
  }

  if (invalidSupplementLabels.length > 0) {
    return {
      success: false,
      errorType: 'invalid_customer_label_values',
      error: `岗位补充标签取值超过 51 字符：${invalidSupplementLabels.join('、')}`,
      invalidSupplementLabels,
      customerLabelDefinitions: definitions,
    };
  }

  return {
    success: true,
    customerLabelList,
    customerLabelDefinitions: definitions,
  };
}

function resolveCustomerLabelValue(
  labelName: string,
  params: BuildCustomerLabelListParams,
): string | null {
  const directAnswer = getSupplementAnswerValue(params.supplementAnswers, labelName);
  if (directAnswer) return directAnswer;

  if (/学历/.test(labelName)) {
    return params.educationId != null ? getSpongeEducationLabelById(params.educationId) : null;
  }

  if (/(籍贯|户籍)/.test(labelName)) {
    return params.householdRegisterProvinceId != null
      ? getSpongeProvinceNameById(params.householdRegisterProvinceId)
      : null;
  }

  if (/身高/.test(labelName)) return formatNumericValue(params.height);
  if (/体重/.test(labelName)) return formatNumericValue(params.weight);

  if (/健康证类型/.test(labelName)) {
    const labels = getSpongeHealthCertificateTypeLabels(params.healthCertificateTypes);
    return labels.length > 0 ? labels.join('、') : null;
  }

  // 覆盖「健康证情况」「有无健康证」「是否有健康证」「健康证」等常见别名；
  // 只要包含"健康证"三字且不是前面的"健康证类型"，都走 hasHealthCertificate 回填
  if (/健康证/.test(labelName)) {
    return params.hasHealthCertificate != null
      ? getSpongeHealthCertificateLabelById(params.hasHealthCertificate)
      : null;
  }

  if (/身份/.test(labelName)) {
    return resolveIdentityLabel(params.context);
  }

  if (/姓名/.test(labelName)) return normalizeText(params.name);
  if (/电话|联系方式/.test(labelName)) return normalizeText(params.phone);
  if (/性别/.test(labelName)) return getSpongeGenderLabelById(params.genderId);
  if (/年龄/.test(labelName)) return String(params.age);
  if (/面试时间/.test(labelName)) return normalizeText(params.interviewTime);
  if (/简历/.test(labelName)) return normalizeText(params.uploadResume);

  return null;
}

function getSupplementAnswerValue(
  supplementAnswers: Record<string, string> | undefined,
  labelName: string,
): string | null {
  if (!supplementAnswers) return null;

  const candidateKeys = [labelName, ...getSupplementAnswerAliases(labelName)];
  for (const key of candidateKeys) {
    const value = normalizeText(supplementAnswers[key]);
    if (value) return value;
  }
  return null;
}

function getSupplementAnswerAliases(labelName: string): string[] {
  if (/(籍贯|户籍)/.test(labelName)) return ['籍贯', '户籍', '户籍省份'];
  if (/身份/.test(labelName)) return ['身份', '是否学生'];
  if (/健康证类型/.test(labelName)) return ['健康证类型'];
  if (/健康证/.test(labelName)) return ['健康证情况', '有无健康证', '是否有健康证', '健康证'];
  return [];
}

function resolveIdentityLabel(context: ToolBuildContext): string | null {
  const interviewInfo = context.sessionFacts?.interview_info;
  if (interviewInfo?.is_student != null) {
    return interviewInfo.is_student ? '学生' : '社会人士';
  }
  if (context.profile?.is_student != null) {
    return context.profile.is_student ? '学生' : '社会人士';
  }
  return null;
}

function resolveStoreName(job: JobDetail): string | null {
  const storeInfo =
    job.basicInfo?.storeInfo && typeof job.basicInfo.storeInfo === 'object'
      ? (job.basicInfo.storeInfo as Record<string, unknown>)
      : null;
  return normalizeText(storeInfo?.storeName) || normalizeText(job.basicInfo?.storeName);
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatNumericValue(value: number | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
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
