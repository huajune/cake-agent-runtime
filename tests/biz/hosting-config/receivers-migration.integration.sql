-- Run with psql -X -v ON_ERROR_STOP=1 -f this-file.sql in an isolated database.
-- Temporary table shadows any real system_config; all changes roll back.
BEGIN;
CREATE TEMP TABLE system_config (key text PRIMARY KEY, value jsonb, description text, updated_at timestamptz DEFAULT now());
INSERT INTO system_config (key, value) VALUES ('hosting_member_config', '{
  "members": {
    "1688855974513959": {"feishuOpenId":"ou_custom","feishuName":"自定义运营","dulidayToken":"keep-hq","future":"keep"},
    "1688855171908166": {"feishuOpenId":" ","dulidayToken":"keep-token","gender":"女"},
    "henan-bot": {"feishuOpenId":"ou_henan","feishuName":"河南成员","dulidayToken":"keep-henan","gender":"男"}
  },
  "taskOwners":{"default":["ou_custom_default"]},
  "extension":{"keep":true}
}');
CREATE TEMP TABLE before_config AS SELECT * FROM system_config;
\ir ../../../supabase/migrations/20261118090000_unify_feishu_receivers_in_database.sql
DO $test$
DECLARE current_value jsonb; previous_value jsonb;
BEGIN
  SELECT value INTO current_value FROM system_config;
  SELECT value INTO previous_value FROM before_config;
  IF current_value #> '{members,henan-bot}' IS DISTINCT FROM previous_value #> '{members,henan-bot}'
    OR current_value #> '{members,1688855974513959}' IS DISTINCT FROM previous_value #> '{members,1688855974513959}'
    OR current_value->'taskOwners' IS DISTINCT FROM previous_value->'taskOwners'
    OR current_value->'extension' IS DISTINCT FROM previous_value->'extension' THEN
    RAISE EXCEPTION 'Existing DB overrides, Henan or top-level settings changed';
  END IF;
  IF current_value #>> '{members,1688855171908166,dulidayToken}' <> 'keep-token'
    OR current_value #>> '{members,1688855171908166,gender}' <> '女'
    OR current_value #>> '{members,1688855171908166,feishuName}' <> '李宇航' THEN
    RAISE EXCEPTION 'Missing receiver was not filled while preserving persona/token';
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(current_value->'members')) <> 12
    OR current_value #>> '{operationsReceivers,0,name}' <> '高雅琪' THEN
    RAISE EXCEPTION 'Historical receiver coverage or operations recipient changed';
  END IF;
END
$test$;
CREATE TEMP TABLE after_first AS SELECT * FROM system_config;
\ir ../../../supabase/migrations/20261118090000_unify_feishu_receivers_in_database.sql
DO $test$
BEGIN
  IF EXISTS (SELECT * FROM system_config EXCEPT SELECT * FROM after_first) THEN
    RAISE EXCEPTION 'Repeated migration changed data';
  END IF;
END
$test$;

-- Explicit empty operations list must survive, as must a nonempty override.
UPDATE system_config SET value = jsonb_set(value, '{operationsReceivers}', '[]');
\ir ../../../supabase/migrations/20261118090000_unify_feishu_receivers_in_database.sql
DO $test$
BEGIN
  IF (SELECT value->'operationsReceivers' FROM system_config) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'Explicit empty operations list was overwritten';
  END IF;
END
$test$;
UPDATE system_config SET value = jsonb_set(value, '{operationsReceivers}', '[{"openId":"ou_override","name":"自定义"}]');
\ir ../../../supabase/migrations/20261118090000_unify_feishu_receivers_in_database.sql
DO $test$
BEGIN
  IF (SELECT value #>> '{operationsReceivers,0,openId}' FROM system_config) <> 'ou_override' THEN
    RAISE EXCEPTION 'Custom operations list was overwritten';
  END IF;
END
$test$;

DELETE FROM system_config;
\ir ../../../supabase/migrations/20261118090000_unify_feishu_receivers_in_database.sql
DO $test$
BEGIN
  IF (SELECT count(*) FROM system_config, jsonb_object_keys(value->'members')) <> 11
    OR (SELECT value::text LIKE '%dulidayToken%' FROM system_config) THEN
    RAISE EXCEPTION 'Empty database seed was incomplete or contained tokens';
  END IF;
END
$test$;
ROLLBACK;
