import type { InterventionPayload } from '@biz/intervention/intervention.service';
import type { CreateFeishuTaskInput } from './feishu-task.types';

export const INTERVENTION_TASK_QUEUE = 'intervention-tasks';
export interface InterventionTaskJob {
  payload: InterventionPayload;
  clientToken: string;
  triggeredAt: string;
  request?: Omit<CreateFeishuTaskInput, 'startAt' | 'dueAt'> & { startAt?: string; dueAt?: string };
  dispatchStartedAt?: number;
  taskGuid?: string;
}
