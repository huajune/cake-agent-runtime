# 海绵轮询分页 EXPLAIN 验证

2026-10-21，在无网络、无宿主端口的 PostgreSQL 15 容器 `cake-runtime-pg-20261021` 的独立 `cake_ops_explain` 数据库验证。所有 600,000 条事件均由 `generate_series` 合成，不含生产记录。60 天窗口约 10,204 条报名事件；另外包含候选人消息与面试通过事件。

基线索引：主键 id、唯一 `(corp_id,event_name,idempotency_key)`、`(report_date,chat_id)`、`(corp_id,event_name,report_date)`。

| 查询 | 实际执行证据 | 执行时间（本机单轮，仅作对照） |
| --- | --- | --- |
| 既有索引，OFFSET 0 LIMIT 100 | 日期索引 + Incremental Sort；过滤掉 6,468 条非报名事件 | 2.873 ms |
| 既有索引，OFFSET 8000 LIMIT 100 | Parallel Seq Scan；3 workers 各读约 200,000 行，Gather Merge 后丢弃前 8,000 条 | 26.926 ms |
| 新部分索引，但仍 OFFSET 8000 | Bitmap Heap Scan 读取窗口 10,204 条报名后排序，仍需跳过 8,000 条 | 32.645 ms |
| 新部分索引 + 元组 seek | Index Cond 包含 `ROW(report_date,id)>ROW(cursorDate,cursorId)`，只取后续 100 条，102 buffers hit | 0.092 ms |
| REST OR 写法 | `(date>cursorDate OR date=cursorDate AND id>cursorId)` 落在 Filter，仍过滤 8,000 条，8,133 buffers hit | 2.919 ms |
| 最终代码：同日剩余范围 | 部分索引 Bitmap Index Cond 同时包含日期等值与 id 下界，读 38 条，46 buffers hit | 0.646 ms |
| 最终代码：后续日期范围 | 部分索引 Index Cond 包含日期下界，取 100 条，103 buffers hit | 1.006 ms |
| 企业内精确 pass 键 | 既有三列唯一索引 Index Only Scan，3 条命中，15 buffers | 0.078 ms |

最终实现把元组 seek 拆为两个精确范围：先读游标同日的 `id>cursorId`，不足 100 条再用 `report_date>cursorDate` 填满余量。这样无需新增 RPC，也不使用会重新过滤历史页的 OR 条件。每轮返回合计至多 100 条，下一游标保存最后一条原报名记录的日期与 id（包括已通过、无需查询海绵的记录），终页清空游标。旧 offset 键不再读取。窗口移动后落在窗口前的游标重置到新窗口开头；游标轮转不会因为新增低日期记录永久跳过它。

新增迁移 `20261021110000_booking_poll_seek_index.sql`：仅为 `event_name='booking.succeeded'` 建 `(report_date,id)` 部分索引。pass 查询保持企业等值 + 事件等值 + 本页业务键集合，不新增冗余索引。迁移尚未执行到生产；部署时必须按数据库变更流程评审建索引锁影响。

可复现数据构造：`n=1..600000`，corp 为 `n%97`；`n%20=0` 为报名、`n%20=1` 为通过、其余为候选人消息；日期为 `2026-10-21-((n/17)%180)`；payload 包含工单号 n 和 120 字符填充。EXPLAIN 使用 `ANALYZE, BUFFERS`，窗口下界 `2026-08-22`，深页游标 `2026-10-09 / 483700`。缓存冷热和合成分布影响绝对耗时，判定依据是索引条件、实际扫描行数和缓冲区访问量，不是把本机时间当作生产承诺。
