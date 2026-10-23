-- 与应用同批发布。保留 message_metadata、RPC 参数和 booking wrapper 的兼容性。
-- 先安装写入边界，存量清洗由带备份/CAS 的显式运维脚本执行；不在迁移中删除业务行。
CREATE OR REPLACE FUNCTION public.memory_fact_timestamp(fact jsonb)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN coalesce((fact->>'updatedAt')::timestamptz, '-infinity'::timestamptz);
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN '-infinity'::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_memory_fact(field_key text, fact jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE v text; canonical text; result jsonb := fact;
BEGIN
  IF jsonb_typeof(fact) IS DISTINCT FROM 'object' OR NOT (fact ? 'value') THEN RETURN NULL; END IF;
  -- null 信封是显式撤销，必须保留时间，阻止旧沉淀重新写活。
  IF fact->'value' <> 'null'::jsonb THEN
    v := btrim(fact->>'value');
    IF field_key IN ('age','height','weight') THEN
      IF jsonb_typeof(fact->'value') <> 'string' OR v !~ '^[0-9]+(\.[0-9]+)?$'
         OR (field_key='age' AND v !~ '^[0-9]+$') THEN RETURN NULL; END IF;
      result := jsonb_set(result,'{value}',to_jsonb(v));
    ELSIF field_key='labor_form' THEN
      IF v NOT IN ('全职','兼职','寒假工','暑假工','小时工') THEN RETURN NULL; END IF;
    ELSIF field_key='has_health_certificate' THEN
      canonical := CASE
        WHEN v IN ('有本地有效健康证','有本地有效') THEN '有本地有效健康证'
        WHEN v IN ('无本地有效健康证，接受办理','无本地有效健康证,接受办理','无但接受办理健康证','无但接受办理','无（愿意办理）','无(愿意办理)','无（准备面试后办理）','无(准备面试后办理)','可重新办') THEN '无本地有效健康证，接受办理'
        WHEN v IN ('无本地有效健康证，不接受办理','无本地有效健康证,不接受办理','无且不接受办理健康证','无且不接受办理','无且不接受') THEN '无本地有效健康证，不接受办理'
        WHEN v IN ('办理中','在办','还没出来','无（补办中）','无(补办中)','正在办理','有（未领证）','有(未领证)','正在办','体检了，还没出证','体检了,还没出证') THEN '办理中'
        ELSE NULL END;
      IF canonical IS NULL THEN RETURN NULL; END IF;
      result := jsonb_set(result,'{value}',to_jsonb(canonical));
    ELSIF field_key='education' THEN
      canonical := CASE v WHEN '中专' THEN '中专技校职高' WHEN '技校' THEN '中专技校职高' WHEN '职高' THEN '中专技校职高' WHEN '专科' THEN '大专' WHEN '研究生' THEN '硕士' WHEN '小学' THEN '初中以下' ELSE v END;
      result := jsonb_set(result,'{value}',to_jsonb(canonical));
    END IF;
  END IF;
  IF jsonb_typeof(result->'evidence')='string' THEN
    v := btrim(result->>'evidence');
    result := jsonb_set(result,'{evidence}',to_jsonb(CASE WHEN char_length(v)>200 THEN left(v,199)||'…' ELSE v END));
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.memory_fact_columns_valid(profile jsonb, intent jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE k text; f jsonb;
BEGIN
  FOR k,f IN SELECT key,value FROM jsonb_each(coalesce(profile,'{}')) UNION ALL SELECT key,value FROM jsonb_each(coalesce(intent,'{}')) LOOP
    IF f='null'::jsonb THEN CONTINUE; END IF;
    IF jsonb_typeof(f)<>'object' OR NOT(f ? 'value') THEN RETURN false; END IF;
    IF char_length(coalesce(f->>'evidence',''))>200 THEN RETURN false; END IF;
    IF k IN ('age','height','weight','labor_form','has_health_certificate') AND public.normalize_memory_fact(k,f) IS DISTINCT FROM f THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_long_term_profile_facts(
  p_corp_id text, p_user_id text, p_bot_user_id text, p_profile_facts jsonb,
  p_message_metadata jsonb DEFAULT NULL, p_preference_facts jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  merged_profile jsonb; merged_intent jsonb; old_fact jsonb; incoming jsonb; k text; dependent text;
  written text[] := '{}'; skipped text[] := '{}'; preference_written boolean := false;
  profile_keys text[] := ARRAY['name','phone','gender','age','is_student','education','has_health_certificate','height','weight'];
  intent_keys text[] := ARRAY['city','district','location','brands','position','schedule','salary','labor_form','schedule_constraint','delayed_intent','available_after'];
BEGIN
  IF NULLIF(btrim(p_bot_user_id),'') IS NULL THEN RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId'; END IF;
  INSERT INTO public.agent_long_term_memories(corp_id,user_id,bot_user_id,semantic_profile,episodic_session_summaries)
    VALUES(p_corp_id,p_user_id,p_bot_user_id,default_long_term_profile_facts(),default_long_term_summary_data())
    ON CONFLICT(corp_id,user_id,bot_user_id) DO NOTHING;
  SELECT coalesce(semantic_profile,default_long_term_profile_facts()),coalesce(semantic_job_intent,'{}')
    INTO merged_profile,merged_intent FROM public.agent_long_term_memories
    WHERE corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id=p_bot_user_id FOR UPDATE;
  FOREACH k IN ARRAY profile_keys LOOP
    incoming := public.normalize_memory_fact(k,p_profile_facts->k);
    IF incoming IS NULL OR incoming->'value'='null'::jsonb THEN CONTINUE; END IF;
    IF NOT(incoming ? 'updatedAt') THEN incoming := jsonb_set(incoming,'{updatedAt}',to_jsonb(now())); END IF;
    old_fact := merged_profile->k;
    IF (old_fact->>'confidence'='high' AND long_term_profile_confidence_rank(coalesce(incoming->>'confidence','unknown'))<3)
       OR public.memory_fact_timestamp(incoming)<public.memory_fact_timestamp(old_fact) THEN
      skipped := array_append(skipped,k); CONTINUE;
    END IF;
    merged_profile := jsonb_set(merged_profile,ARRAY[k],incoming); written := array_append(written,k);
  END LOOP;
  FOREACH k IN ARRAY intent_keys LOOP
    incoming := public.normalize_memory_fact(k,p_preference_facts->k);
    IF incoming IS NULL THEN CONTINUE; END IF;
    IF NOT(incoming ? 'updatedAt') THEN incoming := jsonb_set(incoming,'{updatedAt}',to_jsonb(now())); END IF;
    old_fact := merged_intent->k;
    IF public.memory_fact_timestamp(incoming)<public.memory_fact_timestamp(old_fact) THEN CONTINUE; END IF;
    -- 换城市后旧区域/商圈不能继承；同时间的新区域补丁在后续循环正常写入。
    IF k='city' AND old_fact->'value' IS DISTINCT FROM incoming->'value' THEN
      FOREACH dependent IN ARRAY ARRAY['district','location'] LOOP
        IF public.memory_fact_timestamp(merged_intent->dependent)<=public.memory_fact_timestamp(incoming) THEN
          merged_intent := jsonb_set(merged_intent,ARRAY[dependent],jsonb_set(incoming,'{value}','null'));
        END IF;
      END LOOP;
    END IF;
    merged_intent := jsonb_set(merged_intent,ARRAY[k],incoming); preference_written := true;
  END LOOP;
  IF cardinality(written)>0 OR preference_written OR p_message_metadata IS NOT NULL THEN
    UPDATE public.agent_long_term_memories SET semantic_profile=merged_profile,semantic_job_intent=merged_intent,
      message_metadata=CASE WHEN jsonb_typeof(p_message_metadata)='object' THEN coalesce(message_metadata,'{}')||jsonb_strip_nulls(p_message_metadata) ELSE message_metadata END,
      updated_at=now() WHERE corp_id=p_corp_id AND user_id=p_user_id AND bot_user_id=p_bot_user_id;
  END IF;
  RETURN jsonb_build_object('written_fields',written,'skipped_fields',skipped,'preference_written',preference_written);
END;
$$;

-- 写入完整性检查先以函数提供；完成备份清洗后由同批部署的 validate 脚本安装 CHECK。
-- 不提前安装 NOT VALID：它仍会拦截旧脏行的其他字段更新，造成滚动发布期间误伤。
COMMENT ON COLUMN public.agent_long_term_memories.message_metadata IS '跨系统关联扩展信息；保留外部身份和联系人快照，不因当前召回不消费而退役';
