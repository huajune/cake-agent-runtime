import { useCallback, useState } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ChatSessionCursor, ChatSessionPage } from '@/api/services/chat.service';
import { useDashboardUpdates } from './useDashboardUpdates';

export function useRealtimeChatRecords() {
  const queryClient = useQueryClient();
  const [activeChatIds] = useState<Set<string>>(() => new Set());
  const refresh = useCallback(() => {
    queryClient.setQueriesData<InfiniteData<ChatSessionPage, ChatSessionCursor | null>>(
      { queryKey: ['chat-sessions-optimized'] },
      (old) =>
        !old || old.pages.length <= 1
          ? old
          : { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) },
    );
    void queryClient.invalidateQueries({ queryKey: ['chat-sessions-optimized'] });
    void queryClient.invalidateQueries({ queryKey: ['chat-session-messages'] });
  }, [queryClient]);
  const isLive = useDashboardUpdates(refresh);
  return { isLive, activeChatIds };
}
