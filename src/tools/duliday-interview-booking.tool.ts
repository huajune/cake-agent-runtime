/**
 * DuLiDay 面试预约工具
 *
 * 为求职者预约面试，需要提供完整的个人信息和岗位信息。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { ToolBuilder } from '@shared-types/tool.types';
import {
  API_BOOKING_SUBMISSION_FIELDS,
  getAvailableEducations,
  getEducationIdByName,
} from '@tools/duliday/job-booking.contract';

const logger = new Logger('duliday_interview_booking');

export interface InterviewBookingNotificationInfo {
  candidateName: string;
  brandName?: string;
  storeName?: string;
  interviewTime: string;
  contactInfo: string;
  toolOutput: Record<string, unknown>;
}

export function buildInterviewBookingTool(
  spongeService: SpongeService,
  webhookService: FeishuWebhookService,
  cardBuilder: FeishuCardBuilderService,
): ToolBuilder {
  return (_context) => {
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
          const resultRecord = toRecord(result);

          const toolResult = {
            ...result,
            errorType: result.success ? null : 'booking_rejected',
            requestInfo,
          };

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              contactInfo: phone,
              interviewTime,
              brandName: pickString(resultRecord?.brandName),
              storeName: pickString(resultRecord?.storeName),
              toolOutput: toolResult,
            },
            webhookService,
            cardBuilder,
          );

          return toolResult;
        } catch (err) {
          logger.error('预约面试失败', err);
          const toolResult = {
            success: false,
            errorType: 'booking_request_failed',
            error: `预约面试失败: ${err instanceof Error ? err.message : '未知错误'}`,
            requestInfo,
          };

          void sendInterviewBookingNotification(
            {
              candidateName: name,
              contactInfo: phone,
              interviewTime,
              toolOutput: toolResult,
            },
            webhookService,
            cardBuilder,
          );

          return toolResult;
        }
      },
    });
  };
}

async function sendInterviewBookingNotification(
  bookingInfo: InterviewBookingNotificationInfo,
  webhookService: FeishuWebhookService,
  cardBuilder: FeishuCardBuilderService,
): Promise<void> {
  try {
    const toolOutput = bookingInfo.toolOutput;
    const isFailure = toolOutput.success === false;
    const resultMessage = pickString(toolOutput.message, toolOutput.notice);
    const bookingId = pickString(toolOutput.booking_id);
    const failureReason = pickString(toolOutput.error);
    const failureDetails = stringifyErrorList(toolOutput.errorList);
    const sections: string[] = [];

    if (isFailure) {
      sections.push(`候选人 ${bookingInfo.candidateName} 预约失败，请尽快跟进处理。`);
    }

    sections.push(
      [
        `候选人：${bookingInfo.candidateName}`,
        `联系方式：${maskPhone(bookingInfo.contactInfo)}`,
      ].join('\n'),
    );

    const interviewLines = [
      bookingInfo.brandName ? `品牌：${bookingInfo.brandName}` : null,
      bookingInfo.storeName ? `门店：${bookingInfo.storeName}` : null,
      `面试时间：${bookingInfo.interviewTime}`,
      bookingId ? `预约编号：${bookingId}` : null,
    ].filter((line): line is string => Boolean(line));
    sections.push(`**面试安排**\n${interviewLines.join('\n')}`);

    if (isFailure) {
      const resultLines = [
        failureReason ? `原因：${failureReason}` : null,
        failureDetails ? `明细：${failureDetails}` : null,
        resultMessage ? `返回信息：${resultMessage}` : null,
      ].filter((line): line is string => Boolean(line));
      if (resultLines.length > 0) {
        sections.push(`**失败详情**\n${resultLines.join('\n')}`);
      }
    } else if (resultMessage) {
      sections.push(`结果：${resultMessage}`);
    }

    sections.push(`通知时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

    const card = cardBuilder.buildMarkdownCard({
      title: isFailure ? '⚠️ 面试预约失败' : '🎉 面试预约成功',
      content: sections.join('\n\n'),
      color: isFailure ? 'red' : 'green',
      atAll: true,
    });

    const success = await webhookService.sendMessage('MESSAGE_NOTIFICATION', card);
    if (success) {
      logger.log(`面试预约${isFailure ? '失败' : '成功'}通知已发送: ${bookingInfo.candidateName}`);
    } else {
      logger.warn(`面试预约${isFailure ? '失败' : '成功'}通知发送失败`);
    }
  } catch (error) {
    logger.error(`面试预约通知发送异常: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringifyErrorList(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const text = value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter(Boolean)
    .join('；');

  return text || undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (!/^\d{11}$/.test(trimmed)) return trimmed;
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}
