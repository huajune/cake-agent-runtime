/**
 * DuLiDay 面试预约工具
 *
 * 为求职者预约面试，需要提供完整的个人信息和岗位信息。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { ToolBuilder } from '@shared-types/tool.types';
import {
  API_BOOKING_SUBMISSION_FIELDS,
  getAvailableEducations,
  getEducationIdByName,
} from '@tools/duliday/job-booking.contract';

const logger = new Logger('duliday_interview_booking');

export function buildInterviewBookingTool(spongeService: SpongeService): ToolBuilder {
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

          return {
            ...result,
            errorType: result.success ? null : 'booking_rejected',
            requestInfo: {
              name,
              phone,
              age,
              genderId,
              education,
              hasHealthCertificate,
              jobId,
              interviewTime,
            },
          };
        } catch (err) {
          logger.error('预约面试失败', err);
          return {
            success: false,
            errorType: 'booking_request_failed',
            error: `预约面试失败: ${err instanceof Error ? err.message : '未知错误'}`,
          };
        }
      },
    });
  };
}
