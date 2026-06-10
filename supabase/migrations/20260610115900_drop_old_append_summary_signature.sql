-- 沉淀边界按会话（sessionId=chatId，bot 维度）隔离。
--
-- 背景：summary_data.lastSettledMessageAt 是用户维度（跨 bot 共享），双 bot 服务
-- 同一候选人时，bot A 的沉淀会把边界推到 T，bot B 在 T 之前的会话消息从此被
-- 快速跳过/查询起点裁掉，永不沉淀。新增 summary_data.lastSettledBySession（jsonb
-- map：sessionId → ISO 时间戳），沉淀检测按会话读边界，旧字段保留作回退。
--
-- 同时新增 mark_long_term_settled_boundary RPC：把原应用层 read-then-write 的
-- 边界更新改为行锁内原子更新，避免与并发 append_long_term_summary_atomic 互相覆盖。

-- 旧签名需显式 DROP：直接加 DEFAULT 参数会产生重载歧义（旧 5 参版本与新 6 参版本并存）。
DROP FUNCTION IF EXISTS append_long_term_summary_atomic(text, text, jsonb, text, int);

