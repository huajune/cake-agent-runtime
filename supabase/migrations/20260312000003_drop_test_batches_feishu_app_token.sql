-- Migration: Drop feishu_app_token column from test_batches
-- Reason: feishu_app_token is a fixed document-level identifier shared across all batches.
--         It belongs in app config (env vars + feishu-bitable.config.ts), not the database.
--         Only feishu_table_id is meaningful per-batch (identifies which sheet to write back to).

ALTER TABLE test_batches DROP COLUMN IF EXISTS feishu_app_token;
