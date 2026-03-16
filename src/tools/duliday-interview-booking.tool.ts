/**
 * DuLiDay 面试预约工具
 *
 * 为求职者预约面试，需要提供完整的个人信息和岗位信息。
 *
 * 迁移自 agent/tools/duliday-interview-booking.tool.ts
 * 改造：实现 ToolFactory 接口 + 使用 SpongeService
 */

import { Injectable, Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { SpongeService } from '@sponge/sponge.service';
import { AiTool, ToolBuildContext, ToolFactory } from './tool.types';

// 学历映射
const EDUCATION_MAPPING: Record<number, string> = {
  1: '小学',
  2: '初中',
  3: '高中',
  4: '中专',
  5: '大专',
  6: '本科',
  7: '硕士',
  8: '博士',
};

const EDUCATION_NAME_TO_ID: Record<string, number> = {};
for (const [id, name] of Object.entries(EDUCATION_MAPPING)) {
  EDUCATION_NAME_TO_ID[name] = Number(id);
}

function getEducationIdByName(name: string): number | null {
  return EDUCATION_NAME_TO_ID[name] ?? null;
}

@Injectable()
export class DulidayInterviewBookingToolService implements ToolFactory {
  readonly toolName = 'duliday_interview_booking';
  readonly toolDescription =
    '预约面试。为求职者预约指定岗位的面试，需要提供完整的个人信息包括姓名、电话、性别、年龄、岗位ID和面试时间。';

  private readonly logger = new Logger(DulidayInterviewBookingToolService.name);

  constructor(private readonly spongeService: SpongeService) {}

  buildTool(_context: ToolBuildContext): AiTool {
    return tool({
      description: this.toolDescription,
      inputSchema: z.object({
        name: z.string().describe('求职者姓名'),
        phone: z.string().describe('联系电话'),
        age: z.string().describe('年龄，以字符串形式提供'),
        genderId: z.number().describe('性别ID：1=男，2=女'),
        jobId: z.number().describe('岗位ID，从岗位列表或岗位详情中获取'),
        interviewTime: z
          .string()
          .describe('面试时间，格式：YYYY-MM-DD HH:mm:ss，例如：2025-07-22 13:00:00'),
        education: z
          .string()
          .optional()
          .default('大专')
          .describe('学历，如：初中、高中、大专、本科等。默认为大专'),
        hasHealthCertificate: z
          .number()
          .optional()
          .default(1)
          .describe('是否有健康证：1=有，2=无但接受办理健康证，3=无且不接受办理健康证，默认为1'),
      }),
      execute: async ({
        name,
        phone,
        age,
        genderId,
        jobId,
        interviewTime,
        education = '大专',
        hasHealthCertificate = 1,
      }) => {
        this.logger.log(`预约面试: ${name}, jobId=${jobId}`);

        // 验证必填字段
        const missingFields: string[] = [];
        if (!name) missingFields.push('姓名');
        if (!phone) missingFields.push('联系电话');
        if (!age) missingFields.push('年龄');
        if (!genderId) missingFields.push('性别');
        if (!jobId) missingFields.push('岗位ID');
        if (!interviewTime) missingFields.push('面试时间');

        if (missingFields.length > 0) {
          return { success: false, error: `缺少必填信息：${missingFields.join('、')}` };
        }

        // 验证面试时间格式
        const timeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        if (!timeRegex.test(interviewTime)) {
          return {
            success: false,
            error: '面试时间格式错误，请使用 YYYY-MM-DD HH:mm:ss 格式',
          };
        }

        // 转换学历名称为 ID
        const educationId = getEducationIdByName(education);
        if (!educationId) {
          const available = Object.values(EDUCATION_MAPPING).join('、');
          return { success: false, error: `无效的学历：${education}，支持：${available}` };
        }

        try {
          const result = await this.spongeService.bookInterview({
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
            requestInfo: { name, phone, age, genderId, education, jobId, interviewTime },
          };
        } catch (err) {
          this.logger.error('预约面试失败', err);
          return {
            success: false,
            error: `预约面试失败: ${err instanceof Error ? err.message : '未知错误'}`,
          };
        }
      },
    });
  }
}
