-- Run only in an empty isolated PostgreSQL database, with ON_ERROR_STOP=1.
BEGIN;
CREATE TABLE public.strategy_config (
  id text PRIMARY KEY,
  status text NOT NULL,
  is_active boolean NOT NULL,
  red_lines jsonb
);
CREATE TABLE public.strategy_config_changelog (
  config_id text NOT NULL,
  field text NOT NULL,
  old_value jsonb,
  new_value jsonb,
  changed_by text
);
INSERT INTO public.strategy_config VALUES
  ('testing', 'testing', true, '{"extra":"keep","rules":["保留前项","成都你六姐（六姐）仅上海在招——候选人提及该品牌时默认按上海查询，其他城市候选人直接告知\"该品牌其他城市暂未开店\"。","保留后项"]}'),
  ('released', 'released', true, '{"rules":["品牌开城限制 — 成都你六姐（六姐）目前仅在上海有在招岗位。候选人提到该品牌时无需追问城市，默认按上海查询；若候选人在其他城市，明确告知该品牌当前其他城市暂未开店。"]}'),
  ('edited', 'testing', true, '{"rules":["运营新编辑的品牌规则，保持原值"]}'),
  ('inactive', 'testing', false, '{"rules":["成都你六姐（六姐）仅上海在招——候选人提及该品牌时默认按上海查询，其他城市候选人直接告知\"该品牌其他城市暂未开店\"。"]}'),
  ('historical', 'archived', true, '{"rules":["成都你六姐（六姐）仅上海在招——候选人提及该品牌时默认按上海查询，其他城市候选人直接告知\"该品牌其他城市暂未开店\"。"]}'),
  ('malformed', 'testing', true, '{"rules":null}');
CREATE TEMP TABLE before_configs AS TABLE public.strategy_config;

\ir ../../../supabase/migrations/20261110080000_remove_liujie_city_limit.sql

DO $test$
BEGIN
  IF (SELECT count(*) FROM public.strategy_config_changelog) <> 2 THEN
    RAISE EXCEPTION 'expected exactly two active configuration changes';
  END IF;
  IF (SELECT red_lines FROM public.strategy_config WHERE id = 'testing') <>
    '{"extra":"keep","rules":["保留前项","“成都你六姐”是完整品牌名，名称中的“成都”不代表候选人的求职城市。","保留后项"]}'::jsonb THEN
    RAISE EXCEPTION 'migration changed ordering or unrelated fields';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.strategy_config current JOIN before_configs previous USING (id)
    WHERE current.id IN ('edited', 'inactive', 'historical', 'malformed')
      AND current.red_lines IS DISTINCT FROM previous.red_lines
  ) THEN
    RAISE EXCEPTION 'migration changed a nonmatching or inactive configuration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.strategy_config_changelog log
    JOIN before_configs previous ON previous.id = log.config_id
    JOIN public.strategy_config current ON current.id = log.config_id
    WHERE log.old_value IS DISTINCT FROM previous.red_lines
      OR log.new_value IS DISTINCT FROM current.red_lines
      OR log.field <> 'red_lines' OR log.changed_by <> 'Codex'
  ) THEN
    RAISE EXCEPTION 'audit log does not preserve exact before/after values';
  END IF;
END
$test$;

\ir ../../../supabase/migrations/20261110080000_remove_liujie_city_limit.sql

DO $test$
BEGIN
  IF (SELECT count(*) FROM public.strategy_config_changelog) <> 2 THEN
    RAISE EXCEPTION 'second execution added duplicate changes';
  END IF;
END
$test$;
ROLLBACK;
