-- 重放 20260601100000、20261118090000 的旧种子时，只清理这四个退役号的原始条目。
-- 指纹取自原始条目的 md5(entry::jsonb::text)，以便保留自定义接收人、凭据及重新登记的号。
DO $$
DECLARE
  member_ids text[];
  account_hashes text[];
  old_accounts jsonb;
  kept_accounts jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.stride-primary', 0));
  PERFORM 1 FROM public.system_config
    WHERE key IN ('hosting_member_config', 'sponge_token_config') ORDER BY key FOR UPDATE;

  SELECT array_agg(seed.id) FILTER (
           WHERE md5((cfg.value->'members'->seed.id)::text) = seed.member_hash
         ),
         array_agg(seed.account_hash) FILTER (WHERE seed.account_hash IS NOT NULL)
    INTO member_ids, account_hashes
    FROM (VALUES
      ('1688854263771949', 'd8547bbc7c8236dc8d7665c3428cdafe', NULL),
      ('1688854747775509', 'feeccc03c131328c62baeb53b3b92b24', '4ddd5f0f1f792ebaacb966ec0330758e'),
      ('1688855753660960', '178a282284c9ac099c53aca598f3a9e0', NULL),
      ('1688857592548257', '08325e2ec8d3d1d4fd494e4c885311ef', '50ffdd2a26bdf21ffae593f1b183dbc9')
    ) AS seed(id, member_hash, account_hash)
    LEFT JOIN public.system_config cfg ON cfg.key = 'hosting_member_config'
    WHERE NOT EXISTS (SELECT FROM public.hosting_bot_memberships WHERE bot_im_id = seed.id)
      AND NOT EXISTS (SELECT FROM public.hosting_bot_handovers WHERE bot_im_id = seed.id)
      AND NOT EXISTS (
        SELECT FROM public.hosting_directory_scans
        WHERE bots @> jsonb_build_array(jsonb_build_object('id', seed.id))
      );

  UPDATE public.system_config
    SET value = jsonb_set(value, '{members}', (value->'members') - member_ids), updated_at = now()
    WHERE key = 'hosting_member_config' AND (value->'members') ?| member_ids;

  SELECT value->'accounts' INTO old_accounts FROM public.system_config WHERE key = 'sponge_token_config';
  IF jsonb_typeof(old_accounts) = 'array' AND account_hashes IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(entry ORDER BY pos), '[]'::jsonb) INTO kept_accounts
      FROM jsonb_array_elements(old_accounts) WITH ORDINALITY AS account(entry, pos)
      WHERE md5(entry::text) <> ALL(account_hashes);
    UPDATE public.system_config
      SET value = jsonb_set(value, '{accounts}', kept_accounts), updated_at = now()
      WHERE key = 'sponge_token_config' AND kept_accounts IS DISTINCT FROM old_accounts;
  END IF;
END $$;
