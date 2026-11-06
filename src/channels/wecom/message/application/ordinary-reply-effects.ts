import { z } from 'zod';
import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import type { ReengagementAnchorService } from '@agent/reengagement/anchor.service';

/** Business follow-up obligations survive even when ordinary reply text is abandoned. */
const TOOL_EFFECT_NAMES = [
  'duliday_interview_booking',
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
  'invite_to_group',
] as const;

const effectsSchema = z.object({
  toolCalls: z
    .array(
      z.object({
        toolName: z.enum(TOOL_EFFECT_NAMES),
        args: z.object({ workOrderId: z.number().int().positive().optional() }),
        result: z.object({
          success: z.boolean(),
          workOrderId: z.number().int().positive().optional(),
        }),
      }),
    )
    .max(32),
  context: z.object({
    traceId: z.string().min(1),
    logicalTurnId: z.string().min(1),
    inputOccurredAt: z.string().datetime({ offset: true }),
    chatId: z.string().min(1),
    userId: z.string().min(1),
    corpId: z.string().min(1),
    isGroupChat: z.boolean(),
    channelIdentity: z
      .object({
        candidateName: z.string().optional(),
        managerName: z.string().optional(),
        botImId: z.string().optional(),
        imContactId: z.string().optional(),
        externalUserId: z.string().optional(),
      })
      .optional(),
  }),
});

type AnchorContext = Parameters<ReengagementAnchorService['handleToolAnchors']>[1];

export function ordinaryReplyEffects(
  calls: AgentToolCall[] | undefined,
  context: AnchorContext,
): Record<string, unknown> {
  const toolCalls = (calls ?? [])
    .filter((call) => (TOOL_EFFECT_NAMES as readonly string[]).includes(call.toolName))
    .map((call) => {
      const result =
        call.result && typeof call.result === 'object'
          ? (call.result as Record<string, unknown>)
          : {};
      const args =
        call.args && typeof call.args === 'object' ? (call.args as Record<string, unknown>) : {};
      const workOrderId = result.workOrderId ?? args.workOrderId;
      return {
        toolName: call.toolName,
        args: {},
        result: {
          success:
            result.success === true ||
            (call.toolName === 'duliday_interview_booking' &&
              typeof result.workOrderId === 'number'),
          ...(typeof workOrderId === 'number' && workOrderId > 0 ? { workOrderId } : {}),
        },
      };
    });
  return effectsSchema.parse({
    // 空集合也是生成已结束、无需业务补账的证据；不能和保存失败混为一谈。
    toolCalls: context.isGroupChat ? [] : toolCalls,
    context: { ...context, isGroupChat: Boolean(context.isGroupChat) },
  });
}

export function readOrdinaryReplyEffects(value: unknown): {
  toolCalls: AgentToolCall[];
  context: AnchorContext;
} {
  return effectsSchema.parse(value);
}
