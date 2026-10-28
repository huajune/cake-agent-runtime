-- 仅为中心机器人范围的读取增加索引；总部仍使用原接口及查询。
CREATE INDEX IF NOT EXISTS idx_chat_messages_center_scope ON public.chat_messages (im_bot_id, timestamp DESC, chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_center_detail ON public.chat_messages (im_bot_id, chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ops_events_center_scope ON public.ops_events (bot_im_id, report_date, chat_id);
CREATE INDEX IF NOT EXISTS idx_daily_ops_center_scope ON public.daily_ops_report (bot_im_id, report_date);
