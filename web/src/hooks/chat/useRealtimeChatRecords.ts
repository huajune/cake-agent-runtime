import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDashboardUpdates } from './useDashboardUpdates';

export function useRealtimeChatRecords() {
  const queryClient = useQueryClient();
  const [activeChatIds] = useState<Set<string>>(() => new Set());
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['chat-sessions-optimized'] });
    void queryClient.invalidateQueries({ queryKey: ['chat-session-messages'] });
    void queryClient.invalidateQueries({ queryKey: ['chat-summary-stats'] });
  }, [queryClient]);
  const isLive = useDashboardUpdates(refresh);
  return { isLive, activeChatIds };
}
