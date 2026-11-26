begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

-- Ordinary text has no per-action local projection. The turn owns memory, follow-up
-- and input acknowledgement. Finish the action in the same UPDATE that records
-- the accepted result on the action row. The original dispatch receipt is retained.
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

-- The final pre-send claim locks the action before its turn, in callback lock order.
-- An inspect after a failed precheck may return an existing receipt but never grants a send.
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
  if p_operation not in ('claim','inspect') or p_operation is null or nullif(resource,'') is null then
    raise exception 'invalid reply segment operation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended((p_turn->>'corpId')||':'||resource,0));
  select * into a from public.agent_action_records where corp_id=p_turn->>'corpId' and action_id=id for update;
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
  if a.action_id is not null and (a.resource_hash is distinct from resource
    or a.payload_hash is distinct from p_input->>'payloadHash' or a.request_id is distinct from p_input->>'requestId'
    or (a.account_id,a.chat_id,a.logical_turn_id,a.kind) is distinct from
       (t.account_id,t.chat_id,t.logical_turn_id,'wecom.reply_segment'::text)) then
    return jsonb_build_object('conflict','identity_payload_mismatch');
  end if;
  if a.action_id is not null and (a.mode<>'execute'
    or not (a.status='registered' or (a.status='failed' and a.retryable))) then
    return jsonb_build_object('record',public.action_record_json(a));
  end if;
  if exists(select from public.agent_action_records where corp_id=t.corp_id and resource_hash=resource
      and action_id<>id and mode='execute' and status in ('executing','unknown')) then
    return jsonb_build_object('conflict','unresolved_resource_action');
  end if;
  if p_operation='inspect' then
    return jsonb_build_object('record',case when a.action_id is not null then public.action_record_json(a) end);
  end if;
  if least(deadline,a.recovery_deadline)<=clock_timestamp() then
    return jsonb_build_object('conflict','expired_action');
  end if;
  if a.action_id is not null then
    prepared:=public.transition_agent_action('claim',p_input);
    if prepared->>'conflict' is not null or prepared#>>'{record,dispatch_attempt_id}' is distinct from claimant then
      return prepared;
    end if;
  else
    select action_id into previous_id from public.agent_action_records where corp_id=t.corp_id and resource_hash=resource
      order by created_at desc,action_id desc limit 1;
    insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
      resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,recovery_deadline,previous_action_id,created_at,
      status,owner,dispatch_attempt_id,fence,attempts,next_check_at)
    values(t.corp_id,id,t.account_id,t.chat_id,t.logical_turn_id,'wecom.reply_segment',resource,p_input->>'payloadHash',
      p_input->>'requestId',intent,t.input_occurred_at,'execute',deadline,previous_id,clock_timestamp(),
      'executing',claimant,claimant,1,1,now()+interval '10 minutes') returning * into a;
    prepared:=jsonb_build_object('record',public.action_record_json(a));
  end if;
  -- Only the transaction which changed this attempt to executing issues a grant.
  return prepared||jsonb_build_object('dispatchUntil',least(t.generation_until,
    (prepared#>>'{record,next_check_at}')::timestamptz,(prepared#>>'{record,recovery_deadline}')::timestamptz,
    case when t.fence>1 then (t.recovery->>'resumeUntil')::timestamptz end));
end $$;
revoke all on function public.transition_agent_reply_segment(text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.transition_agent_reply_segment(text,jsonb,jsonb) to service_role;

-- The caller holds the reply-turn lock and has verified the owner and immutable plan.
-- Keep HTTP bytes in the existing per-call table. They never enter the reply recovery JSON.
create or replace function public.capture_ordinary_reply_processing(t public.agent_reply_turns, capture jsonb)
returns void language plpgsql set search_path=public,pg_temp as $$
declare
  trace text := t.recovery->>'traceId';
  m public.message_processing_records;
begin
  if nullif(trace,'') is null or capture#>>'{request,messageId}' is distinct from trace
    or capture#>>'{request,chatId}' is distinct from t.chat_id
    or capture#>>'{request,imBotId}' is distinct from t.account_id then
    raise exception 'reply processing identity mismatch';
  end if;
  -- Intake may still be writing the initial processing row.
  insert into public.message_processing_records(message_id,chat_id,bot_im_id,received_at,status)
    values(trace,t.chat_id,t.account_id,t.input_occurred_at,'processing') on conflict(message_id) do nothing;
  select * into strict m from public.message_processing_records where message_id=trace for update;
  if m.chat_id is distinct from t.chat_id or (m.bot_im_id is not null and m.bot_im_id<>t.account_id) then
    raise exception 'reply processing scope mismatch';
  end if;
  if m.status in ('success','failure') then return; end if;
  perform public.save_processing_snapshot((capture->'record') || jsonb_build_object(
    'message_id',trace,'chat_id',t.chat_id,'received_at',m.received_at,'bot_im_id',t.account_id,'status','processing'),
    capture->'request',capture->'response',coalesce(capture->'invocations','[]'::jsonb));
end $$;
revoke all on function public.capture_ordinary_reply_processing(public.agent_reply_turns,jsonb) from public,anon,authenticated,service_role;

-- Mark actual delivery from the original receipt even if no JS monitoring callback survives.
create or replace function public.settle_ordinary_reply_processing() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  trace text := new.recovery->>'traceId';
  outcome text := new.delivery_result->>'outcome';
  accepted integer := coalesce((new.delivery_result->>'accepted')::integer,0);
  segments integer := jsonb_array_length(old.recovery->'replySegments');
  final_status text := case when outcome in ('complete','skipped') then 'success' else 'failure' end;
  accepted_text text;
begin
  if nullif(trace,'') is null or outcome is null then return new; end if;
  select left(string_agg(segment,E'\n' order by ord),250) into accepted_text
    from jsonb_array_elements_text(old.recovery->'replySegments') with ordinality as s(segment,ord)
    where ord<=accepted;
  update public.message_processing_records m set status=final_status,
    reply_segments=segments, reply_preview=accepted_text,
    error=case when final_status='failure' then 'ordinary_reply_'||outcome end,
    total_duration=least(2147483647,greatest(0,floor(extract(epoch from (now()-m.received_at))*1000)))::integer
    where m.message_id=trace and m.chat_id=new.chat_id and (m.bot_im_id is null or m.bot_im_id=new.account_id)
      and m.status in ('processing','timeout');
  if found then
    update public.message_processing_turn_snapshots s
      set response=coalesce(s.response,'{}'::jsonb) || jsonb_build_object('status',final_status,
        'delivery',jsonb_build_object('outcome',outcome,'deliveredSegments',accepted,'segmentCount',segments,
          'success',outcome='complete','skipped',outcome='skipped'))
      where s.message_id=trace and s.response->>'status'='processing';
  end if;
  return new;
end $$;
revoke all on function public.settle_ordinary_reply_processing() from public,anon,authenticated,service_role;
drop trigger if exists settle_ordinary_reply_processing on public.agent_reply_turns;
create trigger settle_ordinary_reply_processing after update of status on public.agent_reply_turns
  for each row when (old.status is distinct from new.status and new.status='settled' and old.recovery ? 'replySegments')
  execute function public.settle_ordinary_reply_processing();
notify pgrst,'reload schema';
commit;
