CREATE INDEX IF NOT EXISTS idx_processing_center_scope
  ON public.message_processing_records (bot_im_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reengagement_center_scope
  ON public.reengagement_touch_records (bot_im_id, created_at DESC);

-- 所有小组开关使用同一行锁，避免总部与中心操作不同小组时互相覆盖。
CREATE OR REPLACE FUNCTION public.set_hosting_group_blacklisted(
  p_group_id text, p_blacklisted boolean, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp
SET statement_timeout = '4s'
SET lock_timeout = '3s'
AS $$
DECLARE v_items jsonb;
BEGIN
  IF p_group_id IS NULL OR btrim(p_group_id) = '' OR p_blacklisted IS NULL THEN
    RAISE EXCEPTION 'group_id and blacklisted are required';
  END IF;
  INSERT INTO public.system_config(key, value, description)
    VALUES ('group_blacklist', '[]'::jsonb, '小组黑名单（不触发AI回复但记录历史）')
    ON CONFLICT (key) DO NOTHING;
  SELECT value INTO v_items FROM public.system_config
    WHERE key = 'group_blacklist' FOR UPDATE;
  IF jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid group blacklist';
  END IF;
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb) INTO v_items
    FROM jsonb_array_elements(v_items) AS item
    WHERE item->>'group_id' IS DISTINCT FROM p_group_id;
  IF p_blacklisted THEN
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'group_id', p_group_id, 'reason', p_reason,
      'added_at', floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
    ));
  END IF;
  UPDATE public.system_config SET value = v_items, updated_at = now()
    WHERE key = 'group_blacklist';
  RETURN v_items;
END;
$$;
REVOKE ALL ON FUNCTION public.set_hosting_group_blacklisted(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_hosting_group_blacklisted(text, boolean, text) TO service_role;
