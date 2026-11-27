import { z } from 'zod';
import type { HostingGroupSelection } from '@/types/hosting-binding';

export const hostingGroupId = z.string().trim().min(1).max(200);
export const hostingSelection = z
  .object({
    groupId: hostingGroupId,
    previousGroupId: hostingGroupId.nullable(),
    previousOwnerId: z.uuid().nullable(),
  })
  .strict();

export function readHostingSelection(
  value: z.infer<typeof hostingSelection>,
): HostingGroupSelection {
  return {
    groupId: value.groupId,
    previousGroupId: value.previousGroupId ?? null,
    previousOwnerId: value.previousOwnerId ?? null,
  };
}
