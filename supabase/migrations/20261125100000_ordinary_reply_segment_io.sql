begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

-- Ordinary text has no per-action local projection. The turn owns memory, follow-up
-- and input acknowledgement. Finish the action in its receipt UPDATE, before the
-- existing action_pack_accepted_body trigger optionally compacts that same row.
create or replace function public.finish_ordinary_reply_action() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  new.local_sync:='complete';
  new.next_check_at:=null;
  return new;
end $$;
revoke all on function public.finish_ordinary_reply_action() from public, anon, authenticated;
drop trigger if exists action_finish_ordinary_reply on public.agent_action_records;
create trigger action_finish_ordinary_reply before update of status on public.agent_action_records
  for each row when (new.kind='wecom.reply_segment' and new.mode='execute'
    and new.status='succeeded' and new.local_sync='pending')
  execute function public.finish_ordinary_reply_action();

-- Claim or validate one ordinary text segment. Like the callback, lock the action before its turn.
-- Each transaction ends before WeCom is called. Existing/ambiguous attempts keep
-- the ordinary action executor's receipt, retry and resource-conflict semantics.
create or replace function public.transition_agent_reply_segment(p_operation text,p_input jsonb,p_turn jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  t public.agent_reply_turns;
  a public.agent_action_records;
  intent jsonb:=p_input->'intent';
  id text:=p_input->>'actionId';
  claimant text:=p_input->>'owner';
  resource text:=p_input->>'resourceHash';
  previous_id text;
  deadline timestamptz;
  prepared jsonb;
  idx integer;
begin
  if p_operation='claim' and nullif(resource,'') is not null then
    perform pg_advisory_xact_lock(hashtextextended((p_turn->>'corpId')||':'||resource,0));
    select * into a from public.agent_action_records where corp_id=p_turn->>'corpId' and action_id=id for update;
  elsif p_operation='validate_claim' then
    select * into a from public.agent_action_records where corp_id=p_turn->>'corpId' and action_id=id for share;
  else
    raise exception 'invalid reply segment operation';
  end if;
  select * into t from public.agent_reply_turns where corp_id=p_turn->>'corpId'
    and account_id=p_turn->>'accountId' and chat_id=p_turn->>'chatId'
    and logical_turn_id=p_turn->>'logicalTurnId' for share;
  if t.logical_turn_id is null or t.corp_id is distinct from p_input->>'corpId'
    or nullif(id,'') is null or nullif(claimant,'') is null or t.mode<>'execute' or t.status<>'planned'
    or t.owner is null or t.owner is distinct from p_turn->>'owner' or t.fence is distinct from (p_turn->>'fence')::integer
    or t.generation_until is null or t.generation_until<=clock_timestamp()
    or (t.fence>1 and coalesce((t.recovery->>'resumeUntil')::timestamptz,'-infinity')<clock_timestamp()) then
    return jsonb_build_object('conflict','ordinary_reply_fence_lost');
  end if;

  if p_operation='validate_claim' then
    return jsonb_build_object('valid',coalesce(a.mode='execute' and a.kind='wecom.reply_segment'
      and a.account_id=t.account_id and a.chat_id=t.chat_id and a.logical_turn_id=t.logical_turn_id
      and a.owner=claimant and a.fence=(p_input->>'fence')::integer and a.status='executing'
      and a.dispatch_attempt_id=p_input->>'dispatchAttemptId' and a.next_check_at>clock_timestamp()
      and a.recovery_deadline>clock_timestamp() and t.generation_until>clock_timestamp()
      and (t.fence=1 or (t.recovery->>'resumeUntil')::timestamptz>=clock_timestamp()),false));
  end if;
  idx:=(intent#>>'{parameters,index}')::integer;
  deadline:=(p_input->>'recoveryDeadline')::timestamptz;
  if p_input->>'mode' is distinct from 'execute' or idx is null or idx<0
    or intent->>'kind' is distinct from 'wecom.reply_segment'
    or intent->>'corpId' is distinct from t.corp_id or intent->>'accountId' is distinct from t.account_id
    or intent->>'chatId' is distinct from t.chat_id or intent->>'logicalTurnId' is distinct from t.logical_turn_id
    or intent->>'intentId' is distinct from t.logical_turn_id||':reply:v1:'||idx
    or intent->>'target' is distinct from 'chat:'||t.chat_id||':reply:'||t.logical_turn_id||':segment:'||idx
    or jsonb_typeof(intent#>'{parameters,text}') is distinct from 'string'
    or (t.recovery ? 'replySegments' and t.recovery->'replySegments'->>idx is distinct from intent#>>'{parameters,text}')
    or nullif(resource,'') is null or deadline is null then
    return jsonb_build_object('conflict','identity_payload_mismatch');
  end if;
  if a.action_id is not null then
    prepared:=public.transition_agent_action('prepare',p_input);
    if prepared->>'conflict' is not null or a.mode<>'execute'
      or not (a.status='registered' or (a.status='failed' and a.retryable)) then return prepared; end if;
    return public.transition_agent_action('claim',p_input);
  end if;
  if deadline<=clock_timestamp() then return jsonb_build_object('conflict','expired_action'); end if;
  if exists(select from public.agent_action_records where corp_id=t.corp_id and resource_hash=resource
      and mode='execute' and status in ('executing','unknown')) then
    return jsonb_build_object('conflict','unresolved_resource_action');
  end if;
  select action_id into previous_id from public.agent_action_records where corp_id=t.corp_id and resource_hash=resource
    order by created_at desc,action_id desc limit 1;
  insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
    resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,recovery_deadline,previous_action_id,created_at,
    status,owner,dispatch_attempt_id,fence,attempts,next_check_at)
  values(t.corp_id,id,t.account_id,t.chat_id,t.logical_turn_id,'wecom.reply_segment',resource,p_input->>'payloadHash',
    p_input->>'requestId',intent,t.input_occurred_at,'execute',deadline,previous_id,clock_timestamp(),
    'executing',claimant,claimant,1,1,now()+interval '10 minutes') returning * into a;
  return jsonb_build_object('record',public.action_record_json(a));
end $$;
revoke all on function public.transition_agent_reply_segment(text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.transition_agent_reply_segment(text,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
