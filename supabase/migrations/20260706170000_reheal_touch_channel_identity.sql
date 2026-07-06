-- 渠道身份补愈（可安全重复执行）：部署窗口内入队的存量 Bull 任务 payload 无 channelIdentity，
-- 到点各事件落库时身份三列恒为 NULL，且 record_reengagement_touch 的 COALESCE 只认非空
-- 入参、后续事件同样来自无身份的 job.data，行无法自愈。20260706160000 的一次性回填在
-- 这批任务触发前已跑完，故需再补一轮。回填口径与 160000 完全同源：chat_messages 按会话
-- 取最新一条消息的身份快照，只补 candidate_name IS NULL 的行。

DO $$
BEGIN
  IF to_regclass('public.reengagement_touch_records') IS NULL
     OR to_regclass('public.chat_messages') IS NULL THEN
    RETURN;
  END IF;

  UPDATE reengagement_touch_records r
     SET candidate_name = ident.candidate_name,
         manager_name   = COALESCE(r.manager_name, ident.manager_name),
         bot_im_id      = COALESCE(r.bot_im_id, ident.im_bot_id)
    FROM (
      SELECT DISTINCT ON (cm.chat_id) cm.chat_id, cm.candidate_name, cm.manager_name, cm.im_bot_id
        FROM chat_messages cm
       WHERE cm.chat_id IN (
               SELECT DISTINCT session_id FROM reengagement_touch_records WHERE candidate_name IS NULL
             )
       ORDER BY cm.chat_id, cm.timestamp DESC
    ) ident
   WHERE ident.chat_id = r.session_id
     AND r.candidate_name IS NULL;
END $$;
