import { z } from 'zod';
import type { TurnSideEffectIntent } from '@agent/runner/turn-side-effect.types';
import { readTurnSideEffectIntent } from '@agent/runner/turn-outcome';
import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import {
  deliveredReplyAnchorsSchema,
  type AnchorContext,
} from '@agent/reengagement/anchor.service';
import { replyJobProjectionSchema } from '@memory/short-term/assistant-job-projection';

/** Business follow-up obligations survive even when ordinary reply text is abandoned. */
const TOOL_EFFECT_NAMES = [
  'duliday_interview_booking',
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
  'invite_to_group',
] as const;

export const deliveredReplySchema = z.object({
  anchors: deliveredReplyAnchorsSchema.optional(),
  jobs: replyJobProjectionSchema.optional(),
  lastInputAt: z.string().datetime({ offset: true }).optional(),
});
export type DeliveredReplyEffects = z.infer<typeof deliveredReplySchema>;

const effectsSchema = z.object({
  deliveredReply: deliveredReplySchema.optional(),
  afterReply: z
    .array(z.custom<TurnSideEffectIntent>((item) => readTurnSideEffectIntent(item) !== null))
    .optional(),
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

export function ordinaryReplyEffects(
  calls: AgentToolCall[] | undefined,
  context: AnchorContext,
  afterReply?: { intents: TurnSideEffectIntent[]; userMessage: string },
): Record<string, unknown> {
  // Preserve the original handoff key, reason, work order and candidate's question.
  // The alert can reconstruct its context without a copy of the chat or session state.
  const intents = afterReply?.intents
    .filter((intent) => !intent.alreadyDispatched)
    .map((intent) => {
      const copy = {
        ...intent,
        currentMessageContent: intent.currentMessageContent ?? afterReply.userMessage,
      };
      delete copy.recentMessages;
      delete copy.sessionState;
      return copy;
    });
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
    ...(intents?.length ? { afterReply: intents } : {}),
    // 空集合也是生成已结束、无需业务补账的证据；不能和保存失败混为一谈。
    toolCalls: context.isGroupChat ? [] : toolCalls,
    context: { ...context, isGroupChat: Boolean(context.isGroupChat) },
  });
}

export function readOrdinaryReplyEffects(value: unknown): {
  toolCalls: AgentToolCall[];
  context: AnchorContext;
  afterReply?: TurnSideEffectIntent[];
  deliveredReply?: DeliveredReplyEffects;
} {
  return effectsSchema.parse(value);
}
