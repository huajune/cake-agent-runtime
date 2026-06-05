-- 给 message_processing_records 增加 bot_im_id（托管账号系统 wxid）。
--
-- 背景：该表此前只有 manager_name（账号名字态），没有数字 wxid。运营事件回填/分析按
-- 名字态聚合时，与「有 wxid 列」的源表（user_activity / chat_messages）落库形态不一致，
-- 同一个 bot 会因 raw id 不同而在榜单裂成两行。message_processing_records 仍长期使用，
-- 故在此补上 wxid：写入侧（message-tracking）从 botIdentity.imBotId 直接落库，
-- 新数据天然为 wxid 态。存量名字态历史数据按产品决策不回灌。
--
-- 幂等：IF NOT EXISTS 保证可重复执行。

ALTER TABLE message_processing_records
  ADD COLUMN IF NOT EXISTS bot_im_id text;

COMMENT ON COLUMN message_processing_records.bot_im_id IS '托管账号系统 wxid（= bot_im_id），写入侧取 messageData.imBotId；与 user_activity/chat_messages 同一形态，便于按 bot 维度统一聚合';
