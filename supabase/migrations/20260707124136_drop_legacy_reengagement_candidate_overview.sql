-- 修复 20260707114000 已执行环境中的函数重载遗留：
-- 该 migration 为 get_reengagement_candidate_overview 新增 p_status 参数后，
-- PostgreSQL 会保留旧 7 参数签名，未传 p_status 的具名 RPC 调用可能命中
-- "function ... is not unique"。这里显式删除旧签名，保留新的 8 参数函数。

DROP FUNCTION IF EXISTS public.get_reengagement_candidate_overview(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, INT, INT
);
