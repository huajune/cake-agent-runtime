import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

// 新消息到达后，会话条目保持"活跃高亮"的时长
const ACTIVE_FLASH_MS = 3000;
// 防抖：1秒内多次变更只触发一次刷新
const INVALIDATE_DEBOUNCE_MS = 1000;

/**
 * 监听 chat_messages 表的实时变更（聊天记录页）
 *
 * - 收到变更后防抖 invalidate 会话列表/统计/消息详情的 React Query 缓存
 * - 返回 isLive（Realtime 通道是否已连接）供页面展示实时状态指示灯
 * - 返回 activeChatIds（刚收到新消息的会话），供列表做高亮闪烁动效
 */
export function useRealtimeChatRecords() {
  const queryClient = useQueryClient();
  const [isLive, setIsLive] = useState(false);
  const [activeChatIds, setActiveChatIds] = useState<Set<string>>(new Set());
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const flashTimers = flashTimersRef.current;

    const markChatActive = (chatId: string) => {
      setActiveChatIds((prev) => {
        if (prev.has(chatId)) return prev;
        const next = new Set(prev);
        next.add(chatId);
        return next;
      });

      const existing = flashTimers.get(chatId);
      if (existing) clearTimeout(existing);
      flashTimers.set(
        chatId,
        setTimeout(() => {
          flashTimers.delete(chatId);
          setActiveChatIds((prev) => {
            const next = new Set(prev);
            next.delete(chatId);
            return next;
          });
        }, ACTIVE_FLASH_MS),
      );
    };

    const channel = supabase
      .channel('chat-records-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chat_messages',
        },
        (payload) => {
          const chatId = (payload.new as { chat_id?: string } | null)?.chat_id;
          if (chatId) markChatActive(chatId);

          if (invalidateTimerRef.current) clearTimeout(invalidateTimerRef.current);
          invalidateTimerRef.current = setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: ['chat-sessions-optimized'] });
            queryClient.invalidateQueries({ queryKey: ['chat-summary-stats'] });
            queryClient.invalidateQueries({ queryKey: ['chat-daily-stats'] });
            queryClient.invalidateQueries({ queryKey: ['chat-session-messages'] });
          }, INVALIDATE_DEBOUNCE_MS);
        },
      )
      .subscribe((status) => {
        setIsLive(status === 'SUBSCRIBED');
      });

    return () => {
      if (invalidateTimerRef.current) clearTimeout(invalidateTimerRef.current);
      flashTimers.forEach((timer) => clearTimeout(timer));
      flashTimers.clear();
      setIsLive(false);
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return { isLive, activeChatIds };
}
