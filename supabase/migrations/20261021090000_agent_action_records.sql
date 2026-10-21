-- Expand-only. New execute actions require an explicit input cutover boundary.
create table public.agent_action_records (
  corp_id text not null,
  action_id text not null,
  previous_action_id text,
  account_id text not null,
  chat_id text not null,
  logical_turn_id text not null,
  kind text not null,
  resource_hash text not null,
  payload_hash text not null,
  request_id text not null,
  intent jsonb not null,
  input_occurred_at timestamptz not null,
  retention_redacted boolean not null default false,
  mode text not null check (mode in ('off','observe','execute')),
  status text not null default 'registered' check (status in ('registered','executing','succeeded','failed','unknown','cancelled')),
  local_sync text not null default 'complete' check (local_sync in ('pending','complete')),
  owner text,
  dispatch_attempt_id text,
  fence integer not null default 0,
  attempts integer not null default 0,
  result jsonb,
  evidence jsonb,
  retryable boolean not null default false,
  next_check_at timestamptz,
  recovery_deadline timestamptz not null,
  review_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (corp_id, action_id),
  foreign key (corp_id, previous_action_id) references public.agent_action_records(corp_id, action_id)
);

-- Audit ancestry uses the same enterprise/resource scope as conflict serialization.
create index agent_action_resource_history_idx on public.agent_action_records(corp_id,resource_hash,created_at desc,action_id desc);

create index agent_action_due_idx on public.agent_action_records(next_check_at, corp_id, action_id)
  where mode='execute' and next_check_at is not null and (status in ('executing','unknown') or (status='succeeded' and local_sync='pending'));
create index agent_action_unresolved_resource_idx on public.agent_action_records(corp_id, resource_hash)
  where mode='execute' and status in ('executing','unknown');
create index agent_action_retention_idx on public.agent_action_records(updated_at)
  where status in ('succeeded','failed','cancelled') and local_sync='complete' and not retention_redacted;
create index agent_action_completed_resource_idx on public.agent_action_records(corp_id,resource_hash,input_occurred_at) where status='succeeded';

create table public.agent_action_evidence (
  corp_id text not null,
  action_id text not null,
  attempt_id text not null,
  evidence_hash text not null,
  completion jsonb not null,
  created_at timestamptz not null default now(),
  primary key (corp_id, action_id, attempt_id, evidence_hash),
  foreign key (corp_id, action_id) references public.agent_action_records(corp_id, action_id)
);
alter table public.agent_action_records enable row level security;
alter table public.agent_action_evidence enable row level security;
revoke all on public.agent_action_records, public.agent_action_evidence from anon, authenticated;
grant select, insert, update on public.agent_action_records, public.agent_action_evidence to service_role;

-- All mutations serialize by semantic resource, then lock the action row. Expired
-- leases grant reconciliation rights only: dispatch claim cannot reclaim executing.
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
    if r.owner is distinct from p_input->>'owner' or r.fence<>(p_input->>'fence')::integer
      or r.status<>'executing' or r.next_check_at<=now() or r.recovery_deadline<=now() then
      return jsonb_build_object('record',null);
    end if;
  elsif p_operation='cancel' then
    if r.status='registered' then
      update public.agent_action_records set status='cancelled',next_check_at=null,updated_at=now()
        where corp_id=v_corp and action_id=v_id returning * into r;
    end if;
  elsif p_operation='reconcile_claim' then
    if r.next_check_at<=now() and (r.status in ('executing','unknown') or (r.status='succeeded' and r.local_sync='pending')) then
      update public.agent_action_records set status=case when status='executing' then 'unknown' else status end,
        owner=p_input->>'owner',fence=fence+1,attempts=attempts+1,
        next_check_at=now()+interval '10 minutes',updated_at=now()
        where corp_id=v_corp and action_id=v_id returning * into r;
    end if;
  elsif p_operation='settle' then
    -- Retain late evidence even when its writer no longer holds the lease.
    insert into public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
      values(v_corp,v_id,coalesce(p_input->>'dispatchAttemptId',r.dispatch_attempt_id,p_input->>'owner'),p_input->>'evidenceHash',p_input->'completion') on conflict do nothing;
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

-- Operator conclusions are append-only and are not a generic retry button. The caller
-- must present the frozen account, payload and original dispatch attempt being reviewed.
create table public.agent_action_reviews (
  id bigint generated always as identity primary key,
  corp_id text not null,
  action_id text not null,
  operator_id text not null,
  basis text not null,
  conclusion text not null check (conclusion in ('succeeded','failed','leave_unknown','retry_local_sync')),
  completion jsonb,
  created_at timestamptz not null default now(),
  foreign key (corp_id, action_id) references public.agent_action_records(corp_id, action_id)
);
create index agent_action_reviews_action_idx on public.agent_action_reviews(corp_id,action_id,created_at);
alter table public.agent_action_reviews enable row level security;
revoke all on public.agent_action_reviews from public,anon,authenticated;
grant select on public.agent_action_reviews to service_role;

create or replace function public.review_agent_action(p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r public.agent_action_records%rowtype;
  v_corp text := p_input->>'corpId';
  v_id text := p_input->>'actionId';
  v_resource text;
  v_conclusion text := p_input->>'conclusion';
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
      insert into public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
        values(v_corp,v_id,r.dispatch_attempt_id,md5(v_completion::text),v_completion) on conflict do nothing;
      update public.agent_action_records set status=v_conclusion,result=v_completion->'result',evidence=v_completion->'evidence',
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
  return to_jsonb(r);
end $$;
revoke all on function public.review_agent_action(jsonb) from public,anon,authenticated;
grant execute on function public.review_agent_action(jsonb) to service_role;

-- Terminal records retain a minimal tombstone. Unresolved actions and pending local
-- repair are never removed by retention. The previous_action_id chain is retained. Executors reject input older than 90 days.
create or replace function public.redact_completed_agent_actions(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer;
begin
  with batch as (
    select corp_id,action_id from public.agent_action_records
    where updated_at<now()-interval '90 days' and status in ('succeeded','failed','cancelled')
      and local_sync='complete' and not retention_redacted
    order by updated_at limit least(greatest(p_limit,1),100) for update skip locked
  ), redacted as (
    update public.agent_action_records a set intent=a.intent-'parameters'-'recovery'-'target',result=null,evidence=null,retention_redacted=true
    from batch b where a.corp_id=b.corp_id and a.action_id=b.action_id returning a.corp_id,a.action_id
  ), cleaned_reviews as (
    update public.agent_action_reviews v set completion=null
    from redacted r where v.corp_id=r.corp_id and v.action_id=r.action_id
  ) delete from public.agent_action_evidence e using redacted r where e.corp_id=r.corp_id and e.action_id=r.action_id;
  get diagnostics n=row_count;
  return n;
end $$;
revoke all on function public.redact_completed_agent_actions(integer) from public,anon,authenticated;
grant execute on function public.redact_completed_agent_actions(integer) to service_role;
