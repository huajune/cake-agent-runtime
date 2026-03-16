import type {
  StrategyConfigRecord,
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
} from '../types/strategy.types';
import { api, unwrapResponse } from '../client';

export async function getStrategyConfig() {
  const { data } = await api.get('/strategy');
  return unwrapResponse<StrategyConfigRecord>(data);
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
