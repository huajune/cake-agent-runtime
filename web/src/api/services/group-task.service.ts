import { api, unwrapResponse } from '../client';

export interface GroupTaskConfig {
  enabled: boolean;
  dryRun: boolean;
}

export async function getGroupTaskConfig() {
  const { data } = await api.get('/group-task/config');
  return unwrapResponse<GroupTaskConfig>(data);
}

export async function updateGroupTaskConfig(config: Partial<GroupTaskConfig>) {
  const { data } = await api.put('/group-task/config', config);
  return unwrapResponse<GroupTaskConfig>(data);
}

export async function triggerGroupTask(type: string) {
  const { data } = await api.post(`/group-task/trigger/${type}`);
  return unwrapResponse(data);
}
