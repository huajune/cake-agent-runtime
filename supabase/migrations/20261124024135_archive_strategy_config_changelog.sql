BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE SCHEMA IF NOT EXISTS strategy_archive;
REVOKE ALL ON SCHEMA strategy_archive FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
  IF to_regclass('public.strategy_config_changelog') IS NULL THEN
    IF to_regclass('strategy_archive.strategy_config_changelog') IS NULL THEN
      RAISE EXCEPTION 'Strategy changelog is missing from both public and archive schemas';
    END IF;
    RETURN;
  END IF;

  -- Capture the final committed write and hold the lock through retirement.
  LOCK TABLE public.strategy_config_changelog IN ACCESS EXCLUSIVE MODE;
  -- LIKE retains keys, types and lookup indexes. The archive has no cascading FK to live versions.
  CREATE TABLE IF NOT EXISTS strategy_archive.strategy_config_changelog
    (LIKE public.strategy_config_changelog INCLUDING ALL);
  ALTER TABLE strategy_archive.strategy_config_changelog ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE strategy_archive.strategy_config_changelog FROM PUBLIC, anon, authenticated, service_role;

  INSERT INTO strategy_archive.strategy_config_changelog
    SELECT * FROM public.strategy_config_changelog
    ON CONFLICT (id) DO NOTHING;

  IF EXISTS (
    (TABLE public.strategy_config_changelog EXCEPT ALL TABLE strategy_archive.strategy_config_changelog)
    UNION ALL
    (TABLE strategy_archive.strategy_config_changelog EXCEPT ALL TABLE public.strategy_config_changelog)
  ) THEN
    RAISE EXCEPTION 'Strategy changelog differs from archive; retirement aborted';
  END IF;

  -- RESTRICT also makes an unexpected dependent view or foreign key abort the transaction.
  DROP TABLE public.strategy_config_changelog RESTRICT;
END;
$$;

COMMENT ON TABLE strategy_archive.strategy_config_changelog IS
  '退役前的逐字段策略变更历史。保留原始配置 ID、旧值、新值、操作者与时间，仅供受控查询与恢复。';
NOTIFY pgrst, 'reload schema';
COMMIT;
