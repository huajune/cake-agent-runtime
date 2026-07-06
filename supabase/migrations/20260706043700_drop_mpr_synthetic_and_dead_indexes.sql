-- 清理 message_processing_records 的孤儿列与零使用索引
--
-- 1. is_synthetic：20260529 ops_data_foundation 引入的"合成消息标记"，
--    读写两侧最终都未实现（src/ 零引用，全表恒为默认值 false），
--    唯一引用是已执行完毕的一次性回填脚本 scripts/backfill-ops-events-gap-20260605.js。
--    伴生部分索引 idx_mpr_synthetic 约 3MB、生产 idx_scan=0。
-- 2. idx_message_processing_records_anomaly_flags（GIN）：anomaly_flags 只有写入
--    路径，没有任何查询按旗标筛选，生产 idx_scan=0。列本身保留（dashboard 详情在用），
--    仅删索引；将来若加旗标筛选功能再重建。

DROP INDEX IF EXISTS idx_mpr_synthetic;
DROP INDEX IF EXISTS idx_message_processing_records_anomaly_flags;

ALTER TABLE message_processing_records DROP COLUMN IF EXISTS is_synthetic;
