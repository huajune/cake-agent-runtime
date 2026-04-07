import { z } from 'zod';

const PayloadSchema = z.object({}).catchall(z.unknown());

export const EnterpriseMessageCallbackInputSchema = z
  .object({
    orgId: z.string().min(1),
    groupId: z.string().optional(),
    token: z.string().min(1),
    botId: z.string().min(1),
    botUserId: z.string().optional(),
    imBotId: z.string().min(1),
    chatId: z.string().min(1),
    imContactId: z.string().optional(),
    messageType: z.number().int(),
    messageId: z.string().min(1),
    timestamp: z.union([z.string().min(1), z.number().int()]).transform((value) => String(value)),
    isSelf: z.boolean().optional(),
    source: z.number().int().optional(),
    contactType: z.number().int(),
    payload: PayloadSchema,
    imRoomId: z.string().optional(),
    roomName: z.string().optional(),
    roomWecomChatId: z.string().optional(),
    contactName: z.string().optional(),
    externalUserId: z.string().optional(),
    coworker: z.boolean().optional(),
    avatar: z.string().optional(),
    _apiType: z.enum(['enterprise', 'group']).optional(),
  })
  .passthrough();

export const GroupMessageCallbackSchema = z
  .object({
    messageId: z.string().min(1),
    chatId: z.string().min(1),
    avatar: z.string().optional(),
    roomTopic: z.string().optional(),
    roomId: z.string().optional(),
    contactName: z.string().optional(),
    contactId: z.string().optional(),
    payload: PayloadSchema,
    type: z.number().int(),
    timestamp: z.number().int(),
    token: z.string().min(1),
    contactType: z.number().int(),
    coworker: z.boolean().optional(),
    botId: z.string().min(1),
    botWxid: z.string().min(1),
    botWeixin: z.string().optional(),
    isSelf: z.boolean().optional(),
    externalUserId: z.string().nullish(),
    roomWecomChatId: z.string().nullish(),
    mentionSelf: z.boolean().optional(),
  })
  .passthrough();

export const GroupMessageCallbackWrapperSchema = z
  .object({
    data: GroupMessageCallbackSchema,
  })
  .passthrough();

export type EnterpriseMessageCallbackInput = z.infer<typeof EnterpriseMessageCallbackInputSchema>;
export type GroupMessageCallbackInput = z.infer<typeof GroupMessageCallbackSchema>;
