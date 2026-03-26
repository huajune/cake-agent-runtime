import { api, unwrapResponse } from '../client';

export async function triggerGroupTask(type: string) {
  const { data } = await api.post(`/group-task/trigger/${type}`);
  return unwrapResponse(data);
}
