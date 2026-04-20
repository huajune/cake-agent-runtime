-- 把 message_processing_records 加入 supabase_realtime publication，
-- 以便 Dashboard 订阅的 postgres_changes 事件能实时触达前端。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'message_processing_records'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_processing_records;
  END IF;
END
$$;
