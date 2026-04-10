import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

/**
 * 监听 message_processing_records 表的实时变更
 * 收到变更通知后，防抖 invalidate 相关 React Query 缓存
 */
export function useRealtimeMessageProcessing() {
  const queryClient = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel('message-processing-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'message_processing_records',
        },
        () => {
          // 防抖：1秒内多次变更只触发一次刷新
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['message-processing-records'] });
            queryClient.invalidateQueries({ queryKey: ['message-stats'] });
            queryClient.invalidateQueries({ queryKey: ['slowest-messages'] });
          }, 1000);
        },
      )
      .subscribe();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      supabase.removeChannel(channel);
    };
  }, [queryClient]);
}
