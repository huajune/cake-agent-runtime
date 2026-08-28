import { z } from 'zod';

export const FIELD_VALUE_PROPOSAL_OPERATIONS = ['set', 'correct', 'confirm', 'clear'] as const;

const ATTACHMENT_URL_RE = /^https?:\/\/\S+$/iu;

/**
 * precheck 对主模型公开的唯一收资答案协议。
 *
 * `labelTitle` 只负责在本轮实时岗位契约里定位槽位；它无权创建字段，也不参与
 * requiredFields 的生成与排序。值与候选人原话分开承载，继续交字段值提案公证链处理。
 */
export const FieldValueProposalInputSchema = z
  .object({
    labelTitle: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('字段标题，必须逐字取自 bookingChecklist.requiredFields'),
    value: z
      .union([z.string(), z.number(), z.null()])
      .describe('写入槽位的规范值；clear 时必须为 null，禁止传 boolean'),
    quote: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe('候选人原话逐字片段；非文件答案必须能在候选人消息中找到'),
    operation: z
      .enum(FIELD_VALUE_PROPOSAL_OPERATIONS)
      .optional()
      .describe('默认 set；纠正用 correct，确认用 confirm，清除用 clear'),
    agentQuestionQuote: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe('confirm 且值来自 Agent 问句时，传该问句的逐字片段'),
  })
  .superRefine((answer, ctx) => {
    const operation = answer.operation ?? 'set';
    if (operation === 'clear') {
      if (answer.value !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'operation=clear 时 value 必须为 null',
        });
      }
      if (!answer.quote) {
        ctx.addIssue({
          code: 'custom',
          path: ['quote'],
          message: 'operation=clear 必须提供候选人原话 quote',
        });
      }
      return;
    }

    if (answer.value === null || (typeof answer.value === 'string' && !answer.value.trim())) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `${operation} 操作必须提供非空 value`,
      });
    }

    const looksLikeAttachment =
      typeof answer.value === 'string' && ATTACHMENT_URL_RE.test(answer.value.trim());
    if (!answer.quote && !looksLikeAttachment) {
      ctx.addIssue({
        code: 'custom',
        path: ['quote'],
        message: '非文件答案必须提供候选人原话 quote',
      });
    }

    if (operation !== 'confirm' && answer.agentQuestionQuote) {
      ctx.addIssue({
        code: 'custom',
        path: ['agentQuestionQuote'],
        message: 'agentQuestionQuote 只可用于 operation=confirm',
      });
    }

    if (operation === 'confirm') {
      if (!answer.quote) {
        ctx.addIssue({
          code: 'custom',
          path: ['quote'],
          message: 'operation=confirm 必须提供候选人的肯定原话 quote',
        });
      }
      const value = answer.value === null ? '' : String(answer.value).normalize('NFKC').trim();
      const quote = answer.quote?.normalize('NFKC') ?? '';
      if (value && quote && !quote.includes(value) && !answer.agentQuestionQuote) {
        ctx.addIssue({
          code: 'custom',
          path: ['agentQuestionQuote'],
          message: 'confirm 的值不在候选人应答中时，必须绑定真实 Agent 问句',
        });
      }
    }
  });

export type FieldValueProposalInput = z.infer<typeof FieldValueProposalInputSchema>;

/** 兼容模型偶尔把数组整体 JSON 字符串化；公开结构仍只有 FieldValueProposalInput[]。 */
export const FieldValueProposalsInputSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, z.array(FieldValueProposalInputSchema).max(20));
