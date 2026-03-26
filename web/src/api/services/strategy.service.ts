import type {
  StrategyConfigRecord,
  StrategyChangelogRecord,
  StrategyRoleSetting,
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
} from '../types/strategy.types';
import { api, unwrapResponse } from '../client';

export async function getStrategyConfig() {
  const { data } = await api.get('/strategy');
  return unwrapResponse<StrategyConfigRecord>(data);
}

export async function updateRoleSetting(roleSetting: StrategyRoleSetting) {
  const { data } = await api.post('/strategy/role-setting', roleSetting);
  return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
}

export async function updatePersona(persona: StrategyPersona) {
  const { data } = await api.post('/strategy/persona', persona);
  return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
}

export async function updateStageGoals(stageGoals: StrategyStageGoals) {
  const { data } = await api.post('/strategy/stage-goals', stageGoals);
  return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
}

export async function updateRedLines(redLines: StrategyRedLines) {
  const { data } = await api.post('/strategy/red-lines', redLines);
  return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
}

export async function getChangelog(limit = 20) {
  const { data } = await api.get('/strategy/changelog', { params: { limit } });
  return unwrapResponse<StrategyChangelogRecord[]>(data);
}

export async function rollbackConfig(
  field: 'role_setting' | 'persona' | 'stage_goals' | 'red_lines',
  value: unknown,
) {
  const endpointMap: Record<string, string> = {
    role_setting: '/strategy/role-setting',
    persona: '/strategy/persona',
    stage_goals: '/strategy/stage-goals',
    red_lines: '/strategy/red-lines',
  };
  const endpoint = endpointMap[field];
  const { data } = await api.post(endpoint, value);
  return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
}
