-- Summary projections are bounded at the database. Diagnostics, detail, exports
-- and parent-only reads retain the original strings even after snapshot expiry.
BEGIN;
CREATE OR REPLACE FUNCTION public.processing_list_message_preview(m public.message_processing_records)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = '' AS $$
  SELECT left(m.message_preview,50);
$$;
CREATE OR REPLACE FUNCTION public.processing_list_reply_preview(m public.message_processing_records)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = '' AS $$
  SELECT left(m.reply_preview,120);
$$;
REVOKE ALL ON FUNCTION public.processing_list_message_preview(public.message_processing_records),
  public.processing_list_reply_preview(public.message_processing_records) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.processing_list_message_preview(public.message_processing_records),
  public.processing_list_reply_preview(public.message_processing_records) TO service_role;

-- The tenant variant reads a tenant-visible view, and the older variant filters
-- bot IDs. Only the two SELECT expressions change; detail and access scopes stay exact.
DO $migration$
DECLARE
  target regprocedure;
  definition text;
  original text := $old$message_preview AS "messagePreview",reply_preview AS "replyPreview"$old$;
  replacement text := $new$CASE WHEN p_kind='processing-detail' THEN message_preview ELSE left(message_preview,50) END AS "messagePreview",
        CASE WHEN p_kind='processing-detail' THEN reply_preview ELSE left(reply_preview,120) END AS "replyPreview"$new$;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.center_dashboard_processing_read(text,text[],date,date,jsonb)'::regprocedure,
    to_regprocedure('public.tenant_dashboard_processing_read(text,text,date,date,jsonb)')
  ] LOOP
    CONTINUE WHEN target IS NULL;
    definition := pg_get_functiondef(target);
    IF array_length(string_to_array(definition,original),1) <> 2 THEN
      RAISE EXCEPTION 'Unexpected dashboard preview definition for %',target;
    END IF;
    EXECUTE replace(definition,original,replacement);
  END LOOP;
END $migration$;
NOTIFY pgrst,'reload schema';
COMMIT;
