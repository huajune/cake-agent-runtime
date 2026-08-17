import type { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { RESUME_FIELD_NAMES, type ResumeRawField } from '@resolution/candidate/resume-fields';
import { z } from 'zod';

export const RESUME_EXTRACT_SCHEMA = z.object({
  fields: z
    .array(
      z.object({
        field: z.enum(RESUME_FIELD_NAMES),
        value: z.string().min(1).max(160),
        sourceText: z
          .string()
          .min(1)
          .max(120)
          .describe('必须逐字复制自输入规整文本，禁止改写、拼接或补全'),
      }),
    )
    .max(20),
});

const SYSTEM_PROMPT = `你是招聘简历字段抽取器。只抽取输入文本明确写出的字段：
name/phone/gender/age/education/email/expectedCity/jobIntent/expectedSalary/workYears/relevantExperience。
每条必须返回 field、value、sourceText。sourceText 必须是输入文本中逐字连续存在的原句或短片段，
最长 120 字；禁止改写、拼接两处文字、补全常识或输出置信度。relevantExperience 只摘餐饮相关经历，
最多 120 字。字段没有明确证据就不要返回。`;

/** LLM 只作证；调用方必须把结果交给 resolution 公证层，不能直接消费。 */
export async function extractResumeFieldsViaModel(
  text: string,
  llm: LlmExecutorService,
): Promise<ResumeRawField[]> {
  const result = await llm.generateStructured({
    role: ModelRole.Extract,
    schema: RESUME_EXTRACT_SCHEMA,
    outputName: 'ResumeFields',
    system: SYSTEM_PROMPT,
    prompt: `从以下规整简历文本抽取字段：\n\n${text}`,
    thinking: {
      type: 'disabled',
      budgetTokens: 0,
    },
    maxOutputTokens: 800,
  });
  return result.output.fields.map((field) => ({ ...field, extractedBy: 'extract_model' }));
}
