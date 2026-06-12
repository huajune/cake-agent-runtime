-- 把 chat_messages 加入 supabase_realtime publication，
-- 以便聊天记录页（/web/chat-records）订阅的 postgres_changes 事件能实时触达前端。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'chat_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  END IF;
END
$$;
