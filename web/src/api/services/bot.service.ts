import type { BotAccount } from '../types/bot.types';
import { api, unwrapResponse } from '../client';

export async function getConfiguredBotList() {
  const { data } = await api.get('/bot/configured-list');
  return unwrapResponse<BotAccount[]>(data) || [];
}
