ALTER TABLE public.agent_action_records
  ADD COLUMN IF NOT EXISTS accepted_attempt_id text,
  ADD COLUMN IF NOT EXISTS accepted_evidence_hash text,
  ADD COLUMN IF NOT EXISTS body_ref_v1 boolean;

-- The caller already owns the action row lock. Reuse an existing legacy JS/SQL key
-- only after comparing the entire typed JSONB; the provider request ID is untouched.
CREATE OR REPLACE FUNCTION public.store_action_completion(p_corp text,p_id text,p_attempt text,p_body jsonb)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE k text := encode(sha256(convert_to(p_body::text,'UTF8')),'hex'); existing text;
BEGIN
  IF nullif(p_attempt,'') IS NULL OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid action completion';
  END IF;
  SELECT evidence_hash INTO existing FROM public.agent_action_evidence
    WHERE corp_id=p_corp AND action_id=p_id AND attempt_id=p_attempt AND completion=p_body
    ORDER BY (evidence_hash=k) DESC,evidence_hash LIMIT 1;
  IF FOUND THEN RETURN existing; END IF;
  INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
    VALUES(p_corp,p_id,p_attempt,k,p_body) ON CONFLICT DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.agent_action_evidence WHERE corp_id=p_corp AND
      action_id=p_id AND attempt_id=p_attempt AND evidence_hash=k AND completion=p_body) THEN
    RAISE EXCEPTION 'action completion fingerprint collision';
  END IF;
  RETURN k;
END $$;
REVOKE ALL ON FUNCTION public.store_action_completion(text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.action_record_json(r public.agent_action_records)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE body jsonb; res jsonb := to_jsonb(r)-ARRAY['accepted_attempt_id','accepted_evidence_hash','body_ref_v1'];
BEGIN
  IF r.body_ref_v1 IS TRUE THEN
    SELECT completion INTO STRICT body FROM public.agent_action_evidence WHERE corp_id=r.corp_id AND action_id=r.action_id
      AND attempt_id=r.accepted_attempt_id AND evidence_hash=r.accepted_evidence_hash;
    res := res || jsonb_build_object('result',body->'result','evidence',body->'evidence');
  END IF;
  RETURN res;
END $$;
REVOKE ALL ON FUNCTION public.action_record_json(public.agent_action_records) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.action_record_json(public.agent_action_records) TO service_role;

CREATE OR REPLACE FUNCTION public.action_pack_accepted_body() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE body jsonb;
BEGIN
  IF NEW.retention_redacted THEN
    NEW.accepted_attempt_id := NULL; NEW.accepted_evidence_hash := NULL; NEW.body_ref_v1 := NULL;
  ELSIF NEW.body_ref_v1 IS DISTINCT FROM true AND NEW.status='succeeded' AND NEW.local_sync='complete'
     AND NEW.accepted_attempt_id=NEW.dispatch_attempt_id AND NEW.accepted_evidence_hash IS NOT NULL
     AND public.runtime_storage_enabled('action_body') THEN
    SELECT completion INTO STRICT body FROM public.agent_action_evidence WHERE corp_id=NEW.corp_id AND action_id=NEW.action_id
      AND attempt_id=NEW.accepted_attempt_id AND evidence_hash=NEW.accepted_evidence_hash;
    IF body->>'status'='succeeded' AND body->'result' IS NOT DISTINCT FROM NEW.result
       AND body->'evidence' IS NOT DISTINCT FROM NEW.evidence THEN
      NEW.result := NULL; NEW.evidence := NULL; NEW.body_ref_v1 := true;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.action_pack_accepted_body() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS action_pack_accepted_body ON public.agent_action_records;
CREATE TRIGGER action_pack_accepted_body BEFORE UPDATE OF result,evidence,local_sync,retention_redacted
  ON public.agent_action_records FOR EACH ROW EXECUTE FUNCTION public.action_pack_accepted_body();

-- An unresolved attempt can use one unambiguous terminal body. A conflict anywhere
-- in that scoped attempt survives duplicate floods and is routed to existing review.
CREATE OR REPLACE FUNCTION public.action_terminal_evidence(p_corp text,p_action text,p_attempt text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT CASE count(*) WHEN 0 THEN '{"conflicting":false}'::jsonb
    WHEN 1 THEN jsonb_build_object('conflicting',false,'completion',jsonb_agg(completion)->0)
    ELSE '{"conflicting":true}'::jsonb END
  FROM (SELECT DISTINCT completion FROM public.agent_action_evidence
    WHERE corp_id=p_corp AND action_id=p_action AND attempt_id=p_attempt
      AND completion#>'{evidence,requestTerminated}'='true'::jsonb AND
      (completion->>'status'='succeeded' OR (completion->>'status'='failed' AND
       completion#>>'{evidence,kind}'='definitive_no_effect')) LIMIT 2) terminals;
$$;
REVOKE ALL ON FUNCTION public.action_terminal_evidence(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.action_terminal_evidence(text,text,text) TO service_role;

create or replace function public.transition_agent_action(p_operation text, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.agent_action_records%rowtype;
  v_corp text := p_input->>'corpId';
  v_id text := p_input->>'actionId';
  v_resource text;
  v_conflict text;
  v_previous text;
  v_status text;
  v_evidence jsonb;
  v_accepted_hash text;
begin
  if nullif(v_corp,'') is null or nullif(v_id,'') is null then raise exception 'incomplete action identity'; end if;
  select resource_hash into v_resource from public.agent_action_records where corp_id=v_corp and action_id=v_id;
  v_resource := coalesce(v_resource,p_input->>'resourceHash');
  if v_resource is null then return jsonb_build_object('record',null); end if;
  perform pg_advisory_xact_lock(hashtextextended(v_corp || ':' || v_resource,0));
  select * into r from public.agent_action_records where corp_id=v_corp and action_id=v_id for update;

  if p_operation='prepare' then
    select action_id into v_conflict from public.agent_action_records
      where (r.action_id is null or r.status='registered' or (r.status='failed' and r.retryable))
        and corp_id=v_corp and resource_hash=v_resource and action_id<>v_id
        and mode='execute' and status in ('executing','unknown') limit 1;
    if r.action_id is null and p_input->>'mode'<>'off' then
      -- Freeze audit ancestry once, under the resource lock. Never use it as dispatch permission.
      select action_id into v_previous from public.agent_action_records
        where corp_id=v_corp and resource_hash=v_resource
        order by created_at desc,action_id desc limit 1;
      insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
        resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,recovery_deadline,previous_action_id,created_at)
      values(v_corp,v_id,p_input->'intent'->>'accountId',p_input->'intent'->>'chatId',
        p_input->'intent'->>'logicalTurnId',p_input->'intent'->>'kind',v_resource,p_input->>'payloadHash',
        p_input->>'requestId',p_input->'intent',(p_input->'intent'->>'occurredAt')::timestamptz,p_input->>'mode',(p_input->>'recoveryDeadline')::timestamptz,v_previous,clock_timestamp())
      returning * into r;
    end if;
    if r.action_id is not null and (r.payload_hash<>p_input->>'payloadHash'
      or r.account_id<>p_input->'intent'->>'accountId' or r.resource_hash<>p_input->>'resourceHash'
      or r.chat_id<>p_input->'intent'->>'chatId' or r.logical_turn_id<>p_input->'intent'->>'logicalTurnId'
      or r.kind<>p_input->'intent'->>'kind' or r.request_id<>p_input->>'requestId') then
      return jsonb_build_object('record',public.action_record_json(r),'conflict','identity_payload_mismatch');
    end if;
    return jsonb_build_object('record',case when r.action_id is null then null else public.action_record_json(r) end,'conflict',v_conflict);
  end if;

  if r.action_id is null then return jsonb_build_object('record',null); end if;
  if p_operation='claim' then
    if jsonb_typeof(p_input->'owner') is distinct from 'string' or nullif(btrim(p_input->>'owner'),'') is null then raise exception 'dispatch_owner_required'; end if;
    select action_id into v_conflict from public.agent_action_records
      where corp_id=v_corp and resource_hash=v_resource and action_id<>v_id
        and mode='execute' and status in ('executing','unknown') limit 1;
    if v_conflict is not null then return jsonb_build_object('record',public.action_record_json(r),'conflict',v_conflict); end if;
    if (r.status='registered' or (r.status='failed' and r.retryable)) and now()<r.recovery_deadline then
      update public.agent_action_records set status='executing',owner=p_input->>'owner',dispatch_attempt_id=p_input->>'owner',fence=fence+1,
        attempts=attempts+1,next_check_at=now()+interval '10 minutes',updated_at=now()
        where corp_id=v_corp and action_id=v_id returning * into r;
    end if;
  elsif p_operation='validate_claim' then
    if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer
      or nullif(btrim(p_input->>'dispatchAttemptId'),'') is null
      or r.dispatch_attempt_id is distinct from p_input->>'dispatchAttemptId'
      or r.status<>'executing' or r.next_check_at is null or r.next_check_at<=now() or r.recovery_deadline<=now() then
      return jsonb_build_object('record',null);
    end if;
  elsif p_operation='cancel' then
    if r.status='registered' then
      update public.agent_action_records set status='cancelled',next_check_at=null,updated_at=now()
        where corp_id=v_corp and action_id=v_id returning * into r;
    end if;
  elsif p_operation='reconcile_claim' then
    if jsonb_typeof(p_input->'owner') is distinct from 'string' or nullif(btrim(p_input->>'owner'),'') is null then raise exception 'reconciliation_owner_required'; end if;
    if r.next_check_at<=now() and (r.status in ('executing','unknown') or (r.status='succeeded' and r.local_sync='pending')) then
      update public.agent_action_records set status=case when status='executing' then 'unknown' else status end,
        owner=p_input->>'owner',fence=fence+1,attempts=attempts+1,
        next_check_at=now()+interval '10 minutes',updated_at=now()
        where corp_id=v_corp and action_id=v_id returning * into r;
    end if;
  elsif p_operation='settle' then
    if jsonb_typeof(p_input->'dispatchAttemptId') is distinct from 'string'
      or nullif(btrim(p_input->>'dispatchAttemptId'),'') is null then raise exception 'original_dispatch_attempt_required'; end if;
    if nullif(btrim(r.dispatch_attempt_id),'') is null then raise exception 'action_has_no_dispatch_attempt'; end if;
    -- Retain late evidence under its explicit attempt even when its writer lost the lease.
    if r.retention_redacted then return jsonb_build_object('record',null,'conflict','action_redacted'); end if;
    v_accepted_hash := public.store_action_completion(v_corp,v_id,p_input->>'dispatchAttemptId',p_input->'completion');
    if r.dispatch_attempt_id is distinct from p_input->>'dispatchAttemptId' then
      return jsonb_build_object('record',null,'conflict','dispatch_attempt_mismatch');
    end if;
    if r.owner=p_input->>'owner' and r.fence=(p_input->>'fence')::integer and r.status in ('executing','unknown') then
      if (public.action_terminal_evidence(v_corp,v_id,r.dispatch_attempt_id)->>'conflicting')::boolean then
        update public.agent_action_records set status='unknown',review_required=true,retryable=false,next_check_at=now(),updated_at=now()
          where corp_id=v_corp and action_id=v_id returning * into r;
        return jsonb_build_object('record',public.action_record_json(r),'conflict','terminal_evidence_conflict');
      end if;
      v_status := p_input->'completion'->>'status';
      v_evidence := p_input->'completion'->'evidence';
      if v_status='succeeded' and not coalesce((v_evidence->>'requestTerminated')::boolean,false) then v_status:='unknown'; end if;
      if v_status='failed' and (v_evidence->>'kind' is distinct from 'definitive_no_effect' or not coalesce((v_evidence->>'requestTerminated')::boolean,false)) then v_status:='unknown'; end if;
      if v_status not in ('succeeded','failed','unknown','executing') then raise exception 'invalid completion'; end if;
      update public.agent_action_records set status=v_status,review_required=false,
        accepted_attempt_id=r.dispatch_attempt_id,accepted_evidence_hash=v_accepted_hash,body_ref_v1=null,result=p_input->'completion'->'result',evidence=v_evidence,
        local_sync=case when v_status='succeeded' then 'pending' else 'complete' end,
        retryable=(v_status='failed' and coalesce((p_input->'completion'->>'retryable')::boolean,false)),
        next_check_at=case when v_status='failed' then null else now()+interval '30 seconds' end,updated_at=now()
        where corp_id=v_corp and action_id=v_id returning * into r;
    end if;
  elsif p_operation in ('synced','schedule','manual') then
    if r.owner=p_input->>'owner' and r.fence=(p_input->>'fence')::integer then
      if p_operation='synced' and r.status='succeeded' then
        update public.agent_action_records set local_sync='complete',next_check_at=null,updated_at=now()
          where corp_id=v_corp and action_id=v_id returning * into r;
      elsif p_operation='manual' then
        update public.agent_action_records set review_required=true,next_check_at=null,updated_at=now()
          where corp_id=v_corp and action_id=v_id returning * into r;
      elsif p_operation='schedule' then
        update public.agent_action_records set next_check_at=(p_input->>'nextCheckAt')::timestamptz,updated_at=now()
          where corp_id=v_corp and action_id=v_id returning * into r;
      end if;
    end if;
  else raise exception 'unsupported action transition';
  end if;
  return jsonb_build_object('record',public.action_record_json(r));
end $$;
revoke all on function public.transition_agent_action(text,jsonb) from public, anon, authenticated;
grant execute on function public.transition_agent_action(text,jsonb) to service_role;

create or replace function public.append_agent_reply_callback(p_input jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.agent_action_records; v_completion jsonb;
begin
  select * into r from public.agent_action_records where corp_id=p_input->>'corpId'
    and account_id=p_input->>'accountId' and chat_id=p_input->>'chatId' and request_id=p_input->>'requestId'
    and kind='wecom.reply_segment' and mode='execute' limit 1 for update;
  if r.action_id is null or coalesce(p_input->>'messageId','')='' then return false; end if;
  if p_input->>'messageType' is distinct from '7' or r.intent->'parameters'->>'text' is distinct from p_input->>'text' then return false; end if;
  if r.status not in ('executing','unknown','succeeded') or r.dispatch_attempt_id is null then return false; end if;
  v_completion:=jsonb_build_object('status','succeeded','result',jsonb_build_object('channelMessageId',p_input->>'messageId','stage','delivery_callback'),
    'evidence',jsonb_build_object('kind','completed','requestTerminated',true,'externalId',p_input->>'messageId','detail','provider_self_message_callback; not_read_receipt'));
  if r.retention_redacted then return false; end if;
  -- A provider callback carries the external request ID, but no dispatch lease.
  -- A reused request with multiple original attempts cannot identify a unique dispatch.
  if exists(select 1 from public.agent_action_evidence where corp_id=r.corp_id and action_id=r.action_id
    and attempt_id<>r.dispatch_attempt_id) then return false; end if;
  perform public.store_action_completion(r.corp_id,r.action_id,r.dispatch_attempt_id,v_completion);
  update public.agent_action_records set next_check_at=now() where corp_id=r.corp_id and action_id=r.action_id and status in ('executing','unknown');
  update public.agent_reply_turns set next_check_at=now() where corp_id=r.corp_id and logical_turn_id=r.logical_turn_id and status='planned';
  return true;
end $$;
revoke all on function public.append_agent_reply_callback(jsonb) from public,anon,authenticated;
grant execute on function public.append_agent_reply_callback(jsonb) to service_role;

create or replace function public.review_agent_action(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r public.agent_action_records%rowtype;
  v_corp text := p_input->>'corpId';
  v_id text := p_input->>'actionId';
  v_resource text;
  v_conclusion text := p_input->>'conclusion';
  v_accepted_hash text;
  v_completion jsonb := p_input->'completion';
begin
  if nullif(trim(p_input->>'operator'),'') is null or nullif(trim(p_input->>'basis'),'') is null then
    raise exception 'operator and evidence basis required';
  end if;
  select resource_hash into v_resource from public.agent_action_records where corp_id=v_corp and action_id=v_id;
  if v_resource is null then raise exception 'action not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_corp || ':' || v_resource,0));
  select * into r from public.agent_action_records where corp_id=v_corp and action_id=v_id for update;
  if r.mode<>'execute' or r.account_id is distinct from p_input->>'accountId'
    or r.payload_hash is distinct from p_input->>'payloadHash'
    or r.dispatch_attempt_id is distinct from p_input->>'dispatchAttemptId' then
    raise exception 'review action identity mismatch';
  end if;
  if v_conclusion='retry_local_sync' then
    if r.status<>'succeeded' or r.local_sync<>'pending' then raise exception 'no pending local sync'; end if;
    update public.agent_action_records set review_required=false,attempts=0,next_check_at=now(),
      recovery_deadline=now()+interval '24 hours',updated_at=now()
      where corp_id=v_corp and action_id=v_id returning * into r;
  elsif v_conclusion in ('succeeded','failed','leave_unknown') then
    if r.status not in ('executing','unknown') then raise exception 'terminal action cannot be overwritten'; end if;
    if v_conclusion<>'leave_unknown' then
      if v_completion->>'status' is distinct from v_conclusion
        or not coalesce((v_completion->'evidence'->>'requestTerminated')::boolean,false)
        or (v_conclusion='failed' and v_completion->'evidence'->>'kind' is distinct from 'definitive_no_effect')
        or (v_conclusion='succeeded' and not (v_completion ? 'result')) then
        raise exception 'authoritative terminal evidence required';
      end if;
      v_accepted_hash := public.store_action_completion(v_corp,v_id,r.dispatch_attempt_id,v_completion);
      update public.agent_action_records set status=v_conclusion,
        accepted_attempt_id=r.dispatch_attempt_id,accepted_evidence_hash=v_accepted_hash,body_ref_v1=null,result=v_completion->'result',evidence=v_completion->'evidence',
        local_sync=case when v_conclusion='succeeded' then 'pending' else 'complete' end,
        retryable=false,owner=null,fence=fence+1,review_required=false,attempts=0,
        next_check_at=case when v_conclusion='succeeded' then now() else null end,
        recovery_deadline=case when v_conclusion='succeeded' then now()+interval '24 hours' else recovery_deadline end,
        updated_at=now() where corp_id=v_corp and action_id=v_id returning * into r;
    else
      update public.agent_action_records set status='unknown',review_required=true,next_check_at=null,
        owner=null,fence=fence+1,updated_at=now()
        where corp_id=v_corp and action_id=v_id returning * into r;
    end if;
  else raise exception 'unsupported review conclusion';
  end if;
  insert into public.agent_action_reviews(corp_id,action_id,operator_id,basis,conclusion,completion)
    values(v_corp,v_id,p_input->>'operator',p_input->>'basis',v_conclusion,v_completion);
  return public.action_record_json(r);
end $$;
revoke all on function public.review_agent_action(jsonb) from public,anon,authenticated;
grant execute on function public.review_agent_action(jsonb) to service_role;
NOTIFY pgrst,'reload schema';
