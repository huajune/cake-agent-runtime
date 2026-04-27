import { useQuery } from '@tanstack/react-query';
import * as botService from '@/api/services/bot.service';

export type { BotAccount } from '@/api/types/bot.types';

export function useConfiguredBots() {
  return useQuery({
    queryKey: ['configured-bots'],
    queryFn: () => botService.getConfiguredBotList(),
    staleTime: 60000,
    refetchInterval: 60000,
  });
}
