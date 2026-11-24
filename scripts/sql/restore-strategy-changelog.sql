-- Restore the former API's table before rolling back to an application that serves it.
-- Run with psql as the database owner. The private archive survives a rollback.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = public, pg_catalog;

-- This recreates the original primary key, foreign key, lookup indexes and RLS policies.
\ir ../../supabase/migrations/20260319000000_add_strategy_changelog.sql
REVOKE ALL ON TABLE public.strategy_config_changelog FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.strategy_config_changelog TO service_role;

-- The original FK requires the associated strategy versions to exist for an application rollback.
INSERT INTO public.strategy_config_changelog SELECT * FROM strategy_archive.strategy_config_changelog;
DO $$
BEGIN
  IF EXISTS (
    (TABLE strategy_archive.strategy_config_changelog EXCEPT ALL TABLE public.strategy_config_changelog)
    UNION ALL
    (TABLE public.strategy_config_changelog EXCEPT ALL TABLE strategy_archive.strategy_config_changelog)
  ) THEN
    RAISE EXCEPTION 'Restored strategy changelog differs from archive';
  END IF;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
