import type { InterventionPayload } from '@biz/intervention/intervention.service';
import type { CreateFeishuTaskInput, FeishuTaskMember } from './feishu-task.types';

export const INTERVENTION_TASK_QUEUE = 'intervention-tasks';
export interface InterventionTaskJob {
  payload: InterventionPayload;
  clientToken: string;
  triggeredAt: string;
  request?: Omit<CreateFeishuTaskInput, 'startAt' | 'dueAt'> & { startAt?: string; dueAt?: string };
  dispatchStartedAt?: number;
  taskGuid?: string;
  /** Frozen before creation; members are sent through user authorization after GUID persistence. */
  assignment?: {
    delegatedBy: string;
    tasklistGuid: string;
    members: FeishuTaskMember[];
    completedAt?: number;
  };
}
