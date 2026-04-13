/**
 * DuLiDay 面试预约工具
 *
 * 为求职者预约面试，需要提供完整的个人信息和岗位信息。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { PrivateChatMonitorNotifierService } from '@notification/services/private-chat-monitor-notifier.service';
import { ToolBuilder } from '@shared-types/tool.types';
import {
  API_BOOKING_SUBMISSION_FIELDS,
  getAvailableEducations,
  getEducationIdByName,
} from '@tools/duliday/job-booking.contract';

const logger = new Logger('duliday_interview_booking');

export interface InterviewBookingNotificationInfo {
  candidateName: string;
  phone: string;
  genderLabel?: string;
  ageText?: string;
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
): ToolBuilder {
  return (context) => {
    return tool({
      description:
        '预约面试。仅在候选人明确要报名/约面、且岗位与面试时间已确认时调用。这个工具只负责接口字段校验与提交，不负责解释岗位规则或决定现在该追问哪些资料。',
      inputSchema: z.object({
        name: z.string().describe('求职者姓名'),
        phone: z.string().describe('联系电话'),
        age: z.string().describe('年龄，以字符串形式提供'),
        genderId: z.number().describe('性别ID：1=男，2=女'),
        jobId: z.number().describe('岗位ID，从岗位列表或岗位详情中获取'),
        interviewTime: z
          .string()
          .describe('确认后的面试时间，格式：YYYY-MM-DD HH:mm:ss，例如：2025-07-22 13:00:00'),
        education: z
          .string()
          .describe('学历，如：初中、高中、大专、本科等。属于预约提交字段，确认需要时再填写'),
        hasHealthCertificate: z
          .number()
          .describe(
            '是否有健康证：1=有，2=无但接受办理健康证，3=无且不接受办理健康证。属于预约提交字段，确认需要时再填写',
          ),
        brandName: z.string().optional().describe('品牌名称，从岗位列表结果中获取，用于通知展示'),
        storeName: z.string().optional().describe('门店名称，从岗位列表结果中获取，用于通知展示'),
        jobName: z.string().optional().describe('岗位名称，从岗位列表结果中获取，用于通知展示'),
      }),
      execute: async ({
        name,
        phone,
        age,
        genderId,
        jobId,
        interviewTime,
        education,
        hasHealthCertificate,
        brandName: inputBrandName,
        storeName: inputStoreName,
        jobName: inputJobName,
      }) => {
        logger.log(`预约面试: ${name}, jobId=${jobId}`);

        // 验证必填字段
        const apiSubmissionValues = [
          { field: '姓名', value: name },
          { field: '联系电话', value: phone },
          { field: '年龄', value: age },
          { field: '性别', value: genderId },
          { field: '面试时间', value: interviewTime },
          { field: '学历', value: education },
          { field: '健康证情况', value: hasHealthCertificate },
        ];
        const missingFields = apiSubmissionValues
          .filter(({ value }) => value == null || value === '')
          .map(({ field }) => field);

        if (!jobId) missingFields.push('岗位ID');

        if (missingFields.length > 0) {
          return {
            success: false,
            errorType: 'missing_fields',
            missingFields,
            apiSubmissionFields: [...API_BOOKING_SUBMISSION_FIELDS],
            error: `缺少必填信息：${missingFields.join('、')}`,
          };
        }

        // 验证面试时间格式
        const timeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        if (!timeRegex.test(interviewTime)) {
          return {
            success: false,
            errorType: 'invalid_interview_time',
            error: '面试时间格式错误，请使用 YYYY-MM-DD HH:mm:ss 格式',
          };
        }

        // 转换学历名称为 ID
        const educationId = getEducationIdByName(education);
        if (!educationId) {
          const availableEducations = getAvailableEducations();
          const available = availableEducations.join('、');
          return {
            success: false,
            errorType: 'invalid_education',
            availableEducations,
            error: `无效的学历：${education}，支持：${available}`,
          };
        }

        const requestInfo = {
          name,
          phone,
          age,
          genderId,
          education,
          hasHealthCertificate,
          jobId,
          interviewTime,
        };
        const genderLabel = toGenderLabel(genderId);
        const ageText = normalizeAgeText(age);

        try {
          const result = await spongeService.bookInterview({
            name,
            phone,
            age,
            genderId,
            jobId,
            interviewTime,
            educationId,
            hasHealthCertificate,
          });

          context.bookingSucceeded = result.success;

          // 预约失败：自动暂停托管，避免继续自动回复
          if (!result.success) {
            void userHostingService.pauseUser(context.sessionId).then(() => {
              logger.log(`[自动暂停] 预约失败，已暂停托管: chatId=${context.sessionId}`);
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
                  _fixedReply: '我这边预约遇到点小状况，我去找同事确认一下，稍等。',
                  _replyRule:
                    '必须原样输出 _fixedReply 的内容作为回复，禁止添加、修改或补充任何文字',
                }),
          };

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              phone,
              genderLabel,
              ageText,
              interviewTime,
              brandName: inputBrandName,
              storeName: inputStoreName,
              jobName: inputJobName,
              jobId,
              toolOutput: toolResult,
              botImId: context.botImId,
            },
            privateChatNotifier,
          );

          return toolResult;
        } catch (err) {
          logger.error('预约面试失败', err);
          context.bookingSucceeded = false;

          // 预约异常：自动暂停托管，避免继续自动回复
          void userHostingService.pauseUser(context.sessionId).then(() => {
            logger.log(`[自动暂停] 预约异常，已暂停托管: chatId=${context.sessionId}`);
          });

          const toolResult = {
            success: false,
            errorType: 'booking_request_failed',
            error: `预约面试失败: ${err instanceof Error ? err.message : '未知错误'}`,
            requestInfo,
            _outcome: '预约失败',
            _fixedReply: '我这边预约遇到点小状况，我去找同事确认一下，稍等。',
            _replyRule: '必须原样输出 _fixedReply 的内容作为回复，禁止添加、修改或补充任何文字',
          };

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              phone,
              genderLabel,
              ageText,
              interviewTime,
              brandName: inputBrandName,
              storeName: inputStoreName,
              jobName: inputJobName,
              jobId,
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

function toGenderLabel(genderId: number): string | undefined {
  if (genderId === 1) return '男';
  if (genderId === 2) return '女';
  return undefined;
}

function normalizeAgeText(age: string): string {
  const text = age.trim();
  return /岁$/.test(text) ? text : `${text}岁`;
}
