import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDashboardUpdates } from './useDashboardUpdates';

export function useRealtimeMessageProcessing() {
  const queryClient = useQueryClient();
  const refresh = useCallback(() => {
    for (const key of [
      'message-processing-records',
      'message-processing-record-detail',
      'message-stats',
      'slowest-messages',
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);
  useDashboardUpdates(refresh);
}
