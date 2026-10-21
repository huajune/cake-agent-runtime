-- Durable input membership survives partial queue acknowledgement and regrouping.
-- Keep terminal tombstones; only recovery payloads are redacted after 90 days.
create table if not exists public.agent_reply_turns (
  corp_id text not null, account_id text not null, chat_id text not null,
  logical_turn_id text not null, input_ids text[] not null,
  input_occurred_at timestamptz not null, mode text not null check(mode in ('off','observe','execute')),
  status text not null default 'preparing' check(status in ('preparing','planned','settled','acked')),
  owner text, fence integer not null default 1, generation_until timestamptz,
  plan jsonb, recovery jsonb not null default '{}',
  review_required boolean not null default false, next_check_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(corp_id,logical_turn_id), check(cardinality(input_ids)>0)
);
create table if not exists public.agent_reply_inputs (
  corp_id text not null, account_id text not null, chat_id text not null,
  message_id text not null, logical_turn_id text not null,
  primary key(corp_id,account_id,chat_id,message_id),
  foreign key(corp_id,logical_turn_id) references public.agent_reply_turns(corp_id,logical_turn_id)
);
drop index if exists public.agent_reply_turns_pending;
create index agent_reply_turns_pending on public.agent_reply_turns(corp_id,account_id,chat_id,created_at)
  where mode='execute' and status<>'acked';
drop index if exists public.agent_reply_turns_due;
create index agent_reply_turns_due on public.agent_reply_turns(next_check_at)
  where mode='execute' and status in ('preparing','planned','settled') and (recovery->'primary') is not null;
drop index if exists public.agent_reply_turns_retention;
create index agent_reply_turns_retention on public.agent_reply_turns(updated_at)
  where status='acked' and plan is not null;
drop index if exists public.agent_action_callback_lookup;
create unique index agent_action_callback_lookup on public.agent_action_records(corp_id,account_id,request_id);
alter table public.agent_reply_turns enable row level security;
alter table public.agent_reply_inputs enable row level security;
revoke all on public.agent_reply_turns,public.agent_reply_inputs from anon,authenticated;
grant select,insert,update on public.agent_reply_turns,public.agent_reply_inputs to service_role;

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
    end if;
    if r.logical_turn_id is null and v_mode<>'off' then
      insert into public.agent_reply_turns(corp_id,account_id,chat_id,logical_turn_id,input_ids,input_occurred_at,mode,owner,generation_until,recovery,next_check_at)
        values(v_corp,v_account,v_chat,p_input->>'logicalTurnId',v_ids,(p_input->>'inputOccurredAt')::timestamptz,v_mode,p_input->>'owner',now()+interval '10 minutes',coalesce(p_input->'recovery','{}'),now()+interval '10 minutes') returning * into r;
      insert into public.agent_reply_inputs(corp_id,account_id,chat_id,message_id,logical_turn_id)
        select v_corp,v_account,v_chat,unnest(v_ids),r.logical_turn_id;
    elsif r.mode='execute' and r.status='preparing' then
      if r.generation_until>now() then return jsonb_build_object('conflict','generation_owned_elsewhere'); end if;
      if not r.input_ids<@v_ids then return jsonb_build_object('conflict','incomplete_original_input'); end if;
      update public.agent_reply_turns set owner=p_input->>'owner',fence=fence+1,generation_until=now()+interval '10 minutes',next_check_at=now()+interval '10 minutes',updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    end if;
  else
    select * into r from public.agent_reply_turns where corp_id=v_corp and logical_turn_id=p_input->>'logicalTurnId'
      and account_id=v_account and chat_id=v_chat for update;
    if r.logical_turn_id is null then raise exception 'reply turn missing'; end if;
    if p_operation='plan' then
      if r.plan is not null and r.plan<>p_input->'plan' then return jsonb_build_object('conflict','immutable_reply_plan'); end if;
      if r.status='preparing' then
        if r.owner is distinct from p_input->>'owner' or r.fence<>(p_input->>'fence')::integer or r.generation_until<=now() then return jsonb_build_object('conflict','generation_fence_lost'); end if;
        update public.agent_reply_turns set plan=p_input->'plan',status='planned',next_check_at=now()+interval '1 minute',updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='settle' then
      -- Caller settles only after every segment has terminal evidence / explicit cancellation.
      if r.status='planned' then
        if exists(select 1 from jsonb_array_elements(r.plan->'segments') s left join public.agent_action_records a
          on a.corp_id=v_corp and a.action_id=s->>'actionId' and a.account_id=r.account_id and a.chat_id=r.chat_id and a.logical_turn_id=r.logical_turn_id
          where a.action_id is null or a.status not in ('succeeded','cancelled','failed') or (a.status='failed' and a.retryable)) then
          return jsonb_build_object('conflict','unresolved_reply_segments');
        end if;
        update public.agent_reply_turns set status='settled',next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='ack' then
      if r.status not in ('settled','acked') then return jsonb_build_object('conflict','reply_not_settled'); end if;
      if r.status='settled' then
        update public.agent_reply_turns set status='acked',next_check_at=null,updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='defer' then
      update public.agent_reply_turns set review_required=(status='preparing' or (status='planned' and input_occurred_at<now()-interval '1 day')),
        next_check_at=case when status='preparing' or (status='planned' and input_occurred_at<now()-interval '1 day') then null else now()+interval '1 minute' end
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id and status in ('preparing','planned','settled') returning * into r;
    else raise exception 'unknown reply transition'; end if;
  end if;
  return jsonb_build_object('turn',case when r.logical_turn_id is null then null else to_jsonb(r) end);
end $$;
revoke all on function public.transition_agent_reply_turn(text,jsonb) from public,anon,authenticated;
grant execute on function public.transition_agent_reply_turn(text,jsonb) to service_role;

create or replace function public.agent_reply_plan_confirmed(p_corp_id text,p_turn_id text)
returns boolean language sql security definer set search_path=public,pg_temp as $$
  select coalesce((select jsonb_array_length(t.plan->'segments')>0 and not exists(
    select 1 from jsonb_array_elements(t.plan->'segments') s left join public.agent_action_records a
      on a.corp_id=t.corp_id and a.action_id=s->>'actionId' and a.account_id=t.account_id and a.chat_id=t.chat_id and a.logical_turn_id=t.logical_turn_id
      where a.action_id is null or a.status<>'succeeded')
    from public.agent_reply_turns t where t.corp_id=p_corp_id and t.logical_turn_id=p_turn_id),false);
$$;
revoke all on function public.agent_reply_plan_confirmed(text,text) from public,anon,authenticated;
grant execute on function public.agent_reply_plan_confirmed(text,text) to service_role;

-- A callback is evidence, not an unfenced status overwrite. Recovery claims and
-- settles through transition_agent_action. Exact identity + payload are required.
create or replace function public.append_agent_reply_callback(p_input jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.agent_action_records; v_completion jsonb;
begin
  select * into r from public.agent_action_records where corp_id=p_input->>'corpId'
    and account_id=p_input->>'accountId' and chat_id=p_input->>'chatId' and request_id=p_input->>'requestId'
    and kind in ('wecom.reply_segment','group_task.message') and mode='execute' limit 1 for update;
  if r.action_id is null or coalesce(p_input->>'messageId','')='' then return false; end if;
  if r.kind='wecom.reply_segment' then
    if (p_input->>'messageType')::integer<>7 or r.intent->'parameters'->>'text' is distinct from p_input->>'text' then return false; end if;
  elsif r.kind='group_task.message' then
    if r.intent->'parameters'->>'messageType' is distinct from p_input->>'messageType' then return false; end if;
    if (p_input->>'messageType')::integer=7 then
      if r.intent->'parameters'->'payload'->>'text' is distinct from p_input->>'text' then return false; end if;
    elsif (p_input->>'messageType')::integer=9 then
      if coalesce(p_input->'payload'->>'appId','')='' or coalesce(p_input->'payload'->>'username','')='' or coalesce(p_input->'payload'->>'title','')='' or coalesce(p_input->'payload'->>'pagePath','')='' then return false; end if;
      if r.intent->'parameters'->'payload'->>'appid' is distinct from p_input->'payload'->>'appId'
        or r.intent->'parameters'->'payload'->>'username' is distinct from p_input->'payload'->>'username'
        or r.intent->'parameters'->'payload'->>'title' is distinct from p_input->'payload'->>'title'
        or r.intent->'parameters'->'payload'->>'pagePath' is distinct from p_input->'payload'->>'pagePath' then return false; end if;
    else return false; end if;
  end if;
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
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  with candidates as (select corp_id,logical_turn_id from public.agent_reply_turns
    where status='acked' and plan is not null and updated_at<now()-interval '90 days'
    order by updated_at limit least(p_limit,100) for update skip locked)
  update public.agent_reply_turns t set plan=null,recovery='{}' from candidates c
    where t.corp_id=c.corp_id and t.logical_turn_id=c.logical_turn_id;
  get diagnostics n=row_count; return n;
end $$;
revoke all on function public.redact_completed_agent_reply_turns(integer) from public,anon,authenticated;
grant execute on function public.redact_completed_agent_reply_turns(integer) to service_role;
