-- 先部署此扩展迁移，再发布应用：200字预算在模型提炼入口校验。
-- 原话、工具及历史证据完整保留；不回填、不扫描、不修改业务行。
-- 旧应用仍可运行；回滚应用不应回滚此函数以免恢复有损截断。
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
    IF k IN ('age','height','weight','labor_form','has_health_certificate') AND public.normalize_memory_fact(k,f) IS DISTINCT FROM f THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
