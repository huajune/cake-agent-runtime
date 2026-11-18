import { z } from 'zod';
import type { HostingMemberConfig } from './hosting-member-config.types';

const openId = z.string().trim().min(1);
const ownerIds = z.array(openId).optional();

/** 保留扩展字段，但拒绝破损的接收人配置，避免一次刷新清空正在使用的名单。 */
export const hostingMemberConfigSchema: z.ZodType<HostingMemberConfig> = z
  .object({
    members: z
      .record(
        z.string(),
        z
          .object({
            feishuOpenId: z.string().optional(),
            feishuName: z.string().optional(),
            dulidayToken: z.string().optional(),
            wecomNickname: z.string().optional(),
            gender: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    operationsReceivers: z.array(z.object({ openId, name: z.string() })).optional(),
    taskOwners: z
      .object({
        supervisor: ownerIds,
        T4: ownerIds,
        T5: ownerIds,
        T8: ownerIds,
        default: ownerIds,
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
