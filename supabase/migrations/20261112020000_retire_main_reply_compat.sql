-- Contract after all active and rollback consumers use primary single-pass replies.
-- Minimum supported rollback application: v11.15.6. No input/action tombstones are deleted.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
lock table public.agent_reply_turns in access exclusive mode;

do $$
declare has_plan boolean;
begin
  if exists(select 1 from public.agent_reply_turns where delivery_policy<>'single_pass') then
    raise exception 'legacy_frozen_reply_present';
  end if;
  if exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='agent_reply_turns' and column_name='plan') then
    execute 'select exists(select 1 from public.agent_reply_turns where plan is not null)' into has_plan;
    if has_plan then raise exception 'legacy_reply_plan_present'; end if;
  end if;
  if exists(select 1 from public.agent_reply_turns where mode='execute' and projection_status='pending'
    and recovery->'task'->>'kind'='reengagement') then
    raise exception 'legacy_reply_projection_pending';
  end if;
  if exists(select 1 from public.agent_action_records where mode='execute'
    and status in ('executing','unknown') and kind='group_task.message')
    or exists(select 1 from public.agent_action_records where mode='execute'
      and status='succeeded' and local_sync='pending' and kind='group_task.message') then
    raise exception 'legacy_group_obligation_pending';
  end if;
  if exists(select 1 from public.agent_action_records where mode='execute'
    and status in ('executing','unknown') and nullif(btrim(dispatch_attempt_id),'') is null) then
    raise exception 'active_dispatch_identity_missing';
  end if;
end $$;

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
      return jsonb_build_object('record',to_jsonb(r),'conflict','identity_payload_mismatch');
    end if;
    return jsonb_build_object('record',case when r.action_id is null then null else to_jsonb(r) end,'conflict',v_conflict);
  end if;

  if r.action_id is null then return jsonb_build_object('record',null); end if;
  if p_operation='claim' then
    if jsonb_typeof(p_input->'owner') is distinct from 'string' or nullif(btrim(p_input->>'owner'),'') is null then raise exception 'dispatch_owner_required'; end if;
    select action_id into v_conflict from public.agent_action_records
      where corp_id=v_corp and resource_hash=v_resource and action_id<>v_id
        and mode='execute' and status in ('executing','unknown') limit 1;
    if v_conflict is not null then return jsonb_build_object('record',to_jsonb(r),'conflict',v_conflict); end if;
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
    insert into public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
      values(v_corp,v_id,p_input->>'dispatchAttemptId',p_input->>'evidenceHash',p_input->'completion') on conflict do nothing;
    if r.dispatch_attempt_id is distinct from p_input->>'dispatchAttemptId' then
      return jsonb_build_object('record',null,'conflict','dispatch_attempt_mismatch');
    end if;
    if r.owner=p_input->>'owner' and r.fence=(p_input->>'fence')::integer and r.status in ('executing','unknown') then
      v_status := p_input->'completion'->>'status';
      v_evidence := p_input->'completion'->'evidence';
      if v_status='succeeded' and not coalesce((v_evidence->>'requestTerminated')::boolean,false) then v_status:='unknown'; end if;
      if v_status='failed' and (v_evidence->>'kind' is distinct from 'definitive_no_effect' or not coalesce((v_evidence->>'requestTerminated')::boolean,false)) then v_status:='unknown'; end if;
      if v_status not in ('succeeded','failed','unknown','executing') then raise exception 'invalid completion'; end if;
      update public.agent_action_records set status=v_status,review_required=false,result=p_input->'completion'->'result',evidence=v_evidence,
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
  return jsonb_build_object('record',to_jsonb(r));
end $$;
revoke all on function public.transition_agent_action(text,jsonb) from public, anon, authenticated;
grant execute on function public.transition_agent_action(text,jsonb) to service_role;

create or replace function public.transition_agent_reply_turn(p_operation text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.agent_reply_turns; v_corp text:=p_input->>'corpId'; v_account text:=p_input->>'accountId';
  v_chat text:=p_input->>'chatId'; v_ids text[]; v_id text; v_mode text:=p_input->>'mode';
begin
  if coalesce(v_corp,'')='' or coalesce(v_account,'')='' or coalesce(v_chat,'')='' then raise exception 'missing reply scope'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_corp||':'||v_account||':'||v_chat,0));
  if p_operation='open' then
    select array_agg(value) into v_ids from jsonb_array_elements_text(p_input->'inputIds');
    if coalesce(cardinality(v_ids),0)=0 or cardinality(v_ids)>1000 then raise exception 'invalid input membership'; end if;
    -- Prefer membership even for completed turns, so a partial ack never consumes new input.
    select t.* into r from public.agent_reply_inputs i join public.agent_reply_turns t using(corp_id,logical_turn_id)
      where i.corp_id=v_corp and i.account_id=v_account and i.chat_id=v_chat and i.message_id=any(v_ids)
      order by t.created_at limit 1 for update of t;
    if r.logical_turn_id is null then
      select * into r from public.agent_reply_turns where corp_id=v_corp and account_id=v_account and chat_id=v_chat
        and mode='execute' and status<>'acked' order by created_at limit 1 for update;
      if r.logical_turn_id is not null and not (r.input_ids&&v_ids) then
        return jsonb_build_object('conflict','different_reply_intent_pending');
      end if;
    end if;
    if r.logical_turn_id is null and v_mode='execute' then
      if p_input->'recovery'->'task' is not null then
        return jsonb_build_object('conflict','scheduled_reply_task_retired');
      end if;
      if p_input->>'deliveryPolicy' is distinct from 'single_pass'
        or jsonb_typeof(p_input->'recovery'->'primary') is distinct from 'object' then
        return jsonb_build_object('conflict','primary_single_pass_required');
      end if;
      insert into public.agent_reply_turns(corp_id,account_id,chat_id,logical_turn_id,input_ids,input_occurred_at,mode,owner,generation_until,recovery,next_check_at,projection_status,delivery_policy)
        values(v_corp,v_account,v_chat,p_input->>'logicalTurnId',v_ids,(p_input->>'inputOccurredAt')::timestamptz,v_mode,p_input->>'owner',now()+interval '10 minutes',coalesce(p_input->'recovery','{}'),now()+interval '10 minutes',
          'none',
          'single_pass') returning * into r;
      insert into public.agent_reply_inputs(corp_id,account_id,chat_id,message_id,logical_turn_id)
        select v_corp,v_account,v_chat,unnest(v_ids),r.logical_turn_id;
    elsif r.status in ('preparing','planned') then
      -- A second worker may close an expired input, never regenerate or resume its text.
      if r.generation_until>now() then return jsonb_build_object('conflict','ordinary_reply_owned_elsewhere'); end if;
      update public.agent_reply_turns set status='settled',delivery_result=jsonb_build_object('outcome','interrupted'),
        review_required=true,next_check_at=now(),updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    end if;
  else
    select * into r from public.agent_reply_turns where corp_id=v_corp and logical_turn_id=p_input->>'logicalTurnId'
      and account_id=v_account and chat_id=v_chat for update;
    if r.logical_turn_id is null then raise exception 'reply turn missing'; end if;
    if p_operation='save_effects' then
      if r.status<>'preparing' or r.owner is distinct from p_input->>'owner'
        or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if r.recovery->'effects' is not null and r.recovery->'effects'<>p_input->'effects' then
        return jsonb_build_object('conflict','immutable_business_effects');
      end if;
      update public.agent_reply_turns set recovery=recovery||jsonb_build_object('effects',p_input->'effects'),
        projection_status='pending',updated_at=now() where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    elsif p_operation='check_input' then
      if r.status not in ('preparing','planned') or r.owner is null or
        r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
    elsif p_operation in ('start_delivery','check_delivery') then
      if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer
        or r.generation_until<=now() or r.status<>(case when p_operation='start_delivery' then 'preparing' else 'planned' end) then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if p_operation='start_delivery' then
        update public.agent_reply_turns set status='planned',generation_until=now()+interval '10 minutes',next_check_at=now()+interval '10 minutes',updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='interrupt' then
      if r.status in ('preparing','planned') then
        if r.generation_until>now() then return jsonb_build_object('conflict','ordinary_reply_still_owned'); end if;
        update public.agent_reply_turns set status='settled',delivery_result=jsonb_build_object('outcome','interrupted'),
          review_required=true,next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='settle' then
      if r.status in ('preparing','planned') then
        if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
          return jsonb_build_object('conflict','ordinary_reply_fence_lost');
        end if;
        update public.agent_reply_turns set status='settled',
          delivery_result=coalesce(nullif(p_input->'deliveryResult','null'::jsonb),jsonb_build_object('outcome','skipped','accepted',0,'total',0)),
          next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='ack' then
      if r.projection_status='pending' then return jsonb_build_object('conflict','business_effects_pending'); end if;
      if r.status not in ('settled','acked') then return jsonb_build_object('conflict','reply_not_settled'); end if;
      if r.status='settled' then
        update public.agent_reply_turns set status='acked',next_check_at=null,updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='project' then
      if r.status in ('preparing','planned') then
        if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
          return jsonb_build_object('conflict','ordinary_reply_fence_lost');
        end if;
      elsif r.status not in ('settled','acked') then return jsonb_build_object('conflict','reply_not_settled'); end if;
      update public.agent_reply_turns set projection_status='complete',updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id and projection_status='pending' returning * into r;
      if r.logical_turn_id is null then select * into r from public.agent_reply_turns where corp_id=v_corp and logical_turn_id=p_input->>'logicalTurnId'; end if;
    elsif p_operation='defer' then
      if r.status in ('preparing','planned','settled') then
        update public.agent_reply_turns set next_check_at=case when status='settled' then now()+interval '1 minute' else greatest(generation_until,now()+interval '1 minute') end
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    else raise exception 'unknown reply transition'; end if;
  end if;
  return jsonb_build_object('turn',case when r.logical_turn_id is null then null else to_jsonb(r) end);
end $$;
revoke all on function public.transition_agent_reply_turn(text,jsonb) from public,anon,authenticated;
grant execute on function public.transition_agent_reply_turn(text,jsonb) to service_role;

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
  insert into public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
    values(r.corp_id,r.action_id,r.dispatch_attempt_id,md5(v_completion::text),v_completion) on conflict do nothing;
  update public.agent_action_records set next_check_at=now() where corp_id=r.corp_id and action_id=r.action_id and status in ('executing','unknown');
  update public.agent_reply_turns set next_check_at=now() where corp_id=r.corp_id and logical_turn_id=r.logical_turn_id and status='planned';
  return true;
end $$;
revoke all on function public.append_agent_reply_callback(jsonb) from public,anon,authenticated;
grant execute on function public.append_agent_reply_callback(jsonb) to service_role;


create or replace function public.redact_completed_agent_reply_turns(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public,pg_temp set lock_timeout='1s' as $$
declare n integer;
begin
  with candidates as (select corp_id,logical_turn_id from public.agent_reply_turns
    where status='acked' and projection_status<>'pending' and recovery<>'{}'::jsonb and updated_at<now()-interval '90 days'
    order by updated_at limit least(greatest(p_limit,1),100) for update skip locked)
  update public.agent_reply_turns t set recovery='{}' from candidates c
    where t.corp_id=c.corp_id and t.logical_turn_id=c.logical_turn_id;
  get diagnostics n=row_count; return n;
end $$;
revoke all on function public.redact_completed_agent_reply_turns(integer) from public,anon,authenticated;
grant execute on function public.redact_completed_agent_reply_turns(integer) to service_role;

drop function if exists public.agent_reply_plan_confirmed(text,text);
-- PL/pgSQL column references are not all registered dependencies: reject forgotten RPCs.
do $$
begin
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and (p.prosrc like '%projection_next_check_at%'
      or (p.prosrc like '%agent_reply_turns%' and p.prosrc ~ '\mplan\M'))) then
    raise exception 'legacy_reply_column_still_referenced';
  end if;
end $$;
drop index if exists public.agent_reply_task_projection_due;
drop index if exists public.agent_reply_turns_retention;
alter table public.agent_reply_turns drop constraint if exists agent_reply_turns_single_pass_plan_check;
alter table public.agent_reply_turns drop column if exists projection_next_check_at;
alter table public.agent_reply_turns drop column if exists plan;
alter table public.agent_reply_turns alter column delivery_policy set default 'single_pass';
alter table public.agent_reply_turns drop constraint if exists agent_reply_turns_delivery_policy_check;
alter table public.agent_reply_turns add constraint agent_reply_turns_delivery_policy_check check(delivery_policy='single_pass');
create index agent_reply_turns_retention on public.agent_reply_turns(updated_at)
  where status='acked' and projection_status<>'pending' and recovery<>'{}'::jsonb;
commit;
