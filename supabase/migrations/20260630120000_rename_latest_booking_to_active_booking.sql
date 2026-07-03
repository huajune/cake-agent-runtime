ALTER TABLE public.agent_long_term_memories
  RENAME COLUMN latest_booking TO active_booking;

UPDATE public.agent_long_term_memories
SET active_booking = jsonb_build_object(
  'work_order_id', active_booking -> 'latest_work_order_id',
  'linked_at', active_booking -> 'linked_at'
)
WHERE active_booking ? 'latest_work_order_id';

COMMENT ON COLUMN public.agent_long_term_memories.active_booking IS
  '当前有效/待处理预约工单指针；预约成功写入，取消当前工单成功时清空。历史预约以 ops_events 与海绵工单列表为准。';
