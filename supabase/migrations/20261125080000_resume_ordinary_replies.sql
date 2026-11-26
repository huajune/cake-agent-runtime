begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

-- Freeze the approved channel text with its business checkpoint. Older workers keep
-- their single-pass behavior on turns without a checkpoint and cannot close new plans.
create or replace function public.transition_agent_reply_turn(p_operation text,p_input jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.agent_reply_turns; v_corp text:=p_input->>'corpId'; v_account text:=p_input->>'accountId';
  v_chat text:=p_input->>'chatId'; v_ids text[]; v_id text; v_mode text:=p_input->>'mode';
  v_live_lease constant interval := interval '3 minutes';
  v_resume_window constant interval := interval '5 minutes';
  v_resume_until timestamptz; v_uncertain boolean; v_accepted integer; v_total integer;
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
        and mode='execute' and status<>'acked'
        and (status<>'settled' or review_reason is distinct from 'business_effects_unconfirmed' or projection_status<>'none')
        order by created_at limit 1 for update;
      if r.logical_turn_id is not null and not (r.input_ids&&v_ids) then
        return jsonb_build_object('conflict','different_reply_intent_pending');
      end if;
    end if;
    if r.logical_turn_id is null and v_mode='execute' then
      if p_input->'recovery' ?| array['replySegments','resumeUntil'] then return jsonb_build_object('conflict','unverified_reply_segments'); end if;
      if p_input->'recovery'->'task' is not null then
        return jsonb_build_object('conflict','scheduled_reply_task_retired');
      end if;
      if p_input->>'deliveryPolicy' is distinct from 'single_pass'
        or jsonb_typeof(p_input->'recovery'->'primary') is distinct from 'object' then
        return jsonb_build_object('conflict','primary_single_pass_required');
      end if;
      insert into public.agent_reply_turns(corp_id,account_id,chat_id,logical_turn_id,input_ids,input_occurred_at,mode,owner,generation_until,recovery,next_check_at,projection_status,delivery_policy)
        values(v_corp,v_account,v_chat,p_input->>'logicalTurnId',v_ids,(p_input->>'inputOccurredAt')::timestamptz,v_mode,p_input->>'owner',now()+v_live_lease,coalesce(p_input->'recovery','{}'),now()+v_live_lease,
          'none',
          'single_pass') returning * into r;
      insert into public.agent_reply_inputs(corp_id,account_id,chat_id,message_id,logical_turn_id)
        select v_corp,v_account,v_chat,unnest(v_ids),r.logical_turn_id;
    elsif r.status in ('preparing','planned') then
      -- Only the recovery worker may take over a saved delivery. Ingress never regenerates it.
      if r.recovery ? 'replySegments' then return jsonb_build_object('conflict','reply_delivery_pending'); end if;
      if r.generation_until>now() then return jsonb_build_object('conflict','ordinary_reply_owned_elsewhere'); end if;
      update public.agent_reply_turns set status='settled',delivery_result=jsonb_build_object('outcome','interrupted'),
        review_required=true,review_reason=case when projection_status='none' then 'business_effects_unconfirmed'
          else 'ordinary_reply_interrupted_no_resend' end,next_check_at=now(),updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    end if;
  else
    select * into r from public.agent_reply_turns where corp_id=v_corp and logical_turn_id=p_input->>'logicalTurnId'
      and account_id=v_account and chat_id=v_chat for update;
    if r.logical_turn_id is null then raise exception 'reply turn missing'; end if;
    -- Only the original sender's durable heartbeat advances the sending deadline.
    -- A pre-window plan has no reliable last heartbeat; it can still settle its receipts.
    v_resume_until:=coalesce((r.recovery->>'resumeUntil')::timestamptz,'-infinity'::timestamptz);
    if p_operation in ('save_effects','save_reply') then
      if r.status<>'preparing' or r.owner is distinct from p_input->>'owner'
        or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until is null or r.generation_until<=now() then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if r.recovery->'effects' is not null and r.recovery->'effects'<>p_input->'effects' then
        return jsonb_build_object('conflict','immutable_business_effects');
      end if;
      if p_operation='save_reply' then
        if jsonb_typeof(p_input->'effects'->'toolCalls') is distinct from 'array'
          or p_input->'effects'->'context'->>'logicalTurnId' is distinct from r.logical_turn_id
          or p_input->'effects'->'context'->>'corpId' is distinct from r.corp_id
          or p_input->'effects'->'context'->>'chatId' is distinct from r.chat_id then
          return jsonb_build_object('conflict','reply_effects_scope_mismatch');
        end if;
        if jsonb_typeof(p_input->'segments') is distinct from 'array' then
          return jsonb_build_object('conflict','invalid_reply_segments');
        end if;
        if jsonb_array_length(p_input->'segments')=0 or exists (
          select from jsonb_array_elements(p_input->'segments') as elements(segment)
          where jsonb_typeof(segment)<>'string' or btrim(segment#>>'{}')=''
        ) then return jsonb_build_object('conflict','invalid_reply_segments'); end if;
        if r.recovery ? 'replySegments' and r.recovery->'replySegments'<>p_input->'segments' then
          return jsonb_build_object('conflict','immutable_reply_segments');
        end if;
        if p_input ? 'processingCapture' then
          perform public.capture_ordinary_reply_processing(r,p_input->'processingCapture');
        end if;
      end if;
      update public.agent_reply_turns set recovery=recovery||jsonb_build_object('effects',p_input->'effects')
          ||case when p_operation='save_reply' then jsonb_build_object('replySegments',p_input->'segments','resumeUntil',now()+v_resume_window) else '{}'::jsonb end,
        projection_status='pending',updated_at=now() where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    elsif p_operation='save_late_effects' then
      -- The original worker may contribute evidence after expiry, never acquire a new send right.
      if r.mode<>'execute' or r.owner is null or r.owner is distinct from p_input->>'owner'
        or r.fence is distinct from (p_input->>'fence')::integer
        or jsonb_typeof(p_input->'effects'->'toolCalls') is distinct from 'array'
        or p_input->'effects'->'context'->>'logicalTurnId' is distinct from r.logical_turn_id
        or p_input->'effects'->'context'->>'chatId' is distinct from r.chat_id
        or p_input->'effects'->'context'->>'corpId' is distinct from r.corp_id then
        return jsonb_build_object('conflict','late_effects_identity_mismatch');
      end if;
      if r.status in ('settled','acked') and r.recovery->'effects'=p_input->'effects' then
        return jsonb_build_object('turn',to_jsonb(r));
      end if;
      if (r.status='preparing' and r.generation_until<=now()) or
          (r.status='settled' and r.delivery_result->>'outcome'='interrupted') then
        if r.projection_status='none' then
          update public.agent_reply_turns set status='settled',delivery_result=jsonb_build_object('outcome','interrupted'),
            recovery=recovery||jsonb_build_object('effects',p_input->'effects'),projection_status='pending',
            review_required=true,review_reason='ordinary_reply_interrupted_no_resend',next_check_at=now(),updated_at=now()
            where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
        elsif r.recovery->'effects' is distinct from p_input->'effects' then
          return jsonb_build_object('conflict','immutable_business_effects');
        end if;
      else return jsonb_build_object('conflict','late_effects_not_applicable'); end if;
    elsif p_operation in ('check_input','renew') then
      if p_operation='renew' and r.status in ('settled','acked') and r.owner=p_input->>'owner' and r.fence=(p_input->>'fence')::integer then
        return jsonb_build_object('turn',to_jsonb(r));
      end if;
      if r.status not in ('preparing','planned') or r.owner is null or
        r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until is null or r.generation_until<=now() then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if p_operation='renew' and r.fence=1 then
        update public.agent_reply_turns set generation_until=now()+v_live_lease,next_check_at=now()+v_live_lease,
          recovery=case when recovery ? 'replySegments' then recovery||jsonb_build_object('resumeUntil',now()+v_resume_window) else recovery end
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation in ('start_delivery','check_delivery') then
      if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer
        or r.generation_until<=now() or (r.fence>1 and v_resume_until<clock_timestamp())
        or r.status<>(case when p_operation='start_delivery' then 'preparing' else 'planned' end) then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if p_operation='start_delivery' then
        update public.agent_reply_turns set status='planned',generation_until=now()+v_live_lease,next_check_at=now()+v_live_lease,
          recovery=case when recovery ? 'replySegments' then recovery||jsonb_build_object('resumeUntil',now()+v_resume_window) else recovery end,updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='resume_delivery' then
      if r.status in ('settled','acked') then return jsonb_build_object('turn',to_jsonb(r)); end if;
      if r.mode<>'execute' or r.status not in ('preparing','planned') or not (r.recovery ? 'replySegments')
        or r.projection_status='none' or r.generation_until is null
        or (r.generation_until>now() and (r.fence=1 or v_resume_until>=clock_timestamp()))
        or r.fence is distinct from (p_input->>'fence')::integer or r.owner is distinct from p_input->>'owner'
        or nullif(p_input->>'newOwner','') is null or r.owner=p_input->>'newOwner' then
        return jsonb_build_object('conflict','reply_delivery_takeover_unavailable');
      end if;
      if v_resume_until<clock_timestamp() or r.input_occurred_at+interval '24 hours'<=now() then
        -- Expiry revokes dispatch. Already accepted segments still earn their local
        -- effects. Look up each segment via the existing (corp_id, resource_hash)
        -- index, using actionDigest([corpId, target]) from action-records.repository.
        v_total:=jsonb_array_length(r.recovery->'replySegments');
        -- A callback can already be durable while action reconciliation is still queued.
        with segments as materialized (
          select s.ord,a.status,a.review_required,
            case when a.status in ('executing','unknown') or a.review_required
              then public.action_terminal_evidence(a.corp_id,a.action_id,a.dispatch_attempt_id) end as receipt
          from jsonb_array_elements_text(r.recovery->'replySegments') with ordinality as s(body,ord)
          left join public.agent_action_records a
            on a.corp_id=r.corp_id and a.resource_hash=encode(sha256(convert_to(
              '['||to_json(r.corp_id)::text||','||to_json('chat:'||r.chat_id||':reply:'||r.logical_turn_id||':segment:'||(s.ord-1))::text||']','UTF8')),'hex')
            and a.account_id=r.account_id and a.chat_id=r.chat_id and a.logical_turn_id=r.logical_turn_id
            and a.kind='wecom.reply_segment' and a.mode='execute'
            and a.intent->>'intentId'=r.logical_turn_id||':reply:v1:'||(s.ord-1)
            and a.intent->'parameters'->>'text'=s.body
        ), resolved as (
          select ord,case when receipt->>'conflicting'='true' then 'unknown'
                          else coalesce(receipt#>>'{completion,status}',status) end as state,
            review_required and receipt->'completion' is null as needs_review from segments
        )
        select coalesce(min(ord-1) filter (where state is distinct from 'succeeded'),v_total)::integer,
               coalesce(bool_or(state in ('executing','unknown') or needs_review),false)
          into v_accepted,v_uncertain from resolved;
        update public.agent_reply_turns set status='settled',
          delivery_result=jsonb_build_object('outcome',case when v_uncertain then 'unknown'
            when v_accepted=v_total then 'complete' else 'skipped' end,'accepted',v_accepted,'total',v_total),
          recovery=case when v_uncertain then recovery-'resumeUntil' else recovery-array['replySegments','resumeUntil'] end,
          review_required=v_uncertain,review_reason=case when v_uncertain then 'recovery_deadline' end,
          next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      else
        update public.agent_reply_turns set status='planned',owner=p_input->>'newOwner',fence=fence+1,
          generation_until=least(now()+interval '90 seconds',input_occurred_at+interval '24 hours'),
          next_check_at=least(now()+interval '90 seconds',v_resume_until,input_occurred_at+interval '24 hours'),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='interrupt' then
      if r.status in ('preparing','planned') then
        if r.recovery ? 'replySegments' then return jsonb_build_object('conflict','reply_delivery_pending'); end if;
        if r.generation_until>now() then return jsonb_build_object('conflict','ordinary_reply_still_owned'); end if;
        update public.agent_reply_turns set status='settled',delivery_result=jsonb_build_object('outcome','interrupted'),
          review_required=true,review_reason=case when projection_status='none' then 'business_effects_unconfirmed'
          else 'ordinary_reply_interrupted_no_resend' end,next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='settle' then
      if r.status in ('preparing','planned') then
        if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until is null or r.generation_until<=now() then
          return jsonb_build_object('conflict','ordinary_reply_fence_lost');
        end if;
        if r.recovery ? 'replySegments' and jsonb_typeof(p_input->'deliveryResult') is distinct from 'object' then
          return jsonb_build_object('conflict','planned_delivery_result_required');
        end if;
        update public.agent_reply_turns set status='settled',recovery=recovery-array['replySegments','resumeUntil'],
          delivery_result=coalesce(nullif(p_input->'deliveryResult','null'::jsonb),jsonb_build_object('outcome','skipped','accepted',0,'total',0)),
          next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='ack' then
      if r.projection_status='none' then return jsonb_build_object('conflict','business_effects_unconfirmed'); end if;
      if r.projection_status='pending' then return jsonb_build_object('conflict','business_effects_pending'); end if;
      if r.status not in ('settled','acked') then return jsonb_build_object('conflict','reply_not_settled'); end if;
      if r.status='settled' then
        if r.recovery->'effects' ? 'afterReply' and p_input->'afterReplyHandled' is distinct from 'true'::jsonb then
          return jsonb_build_object('conflict','reply_handoff_pending');
        end if;
        if r.recovery->'effects' ? 'deliveredReply' and p_input->'deliveredReplyHandled' is distinct from 'true'::jsonb then
          return jsonb_build_object('conflict','delivered_reply_effects_pending');
        end if;
        update public.agent_reply_turns set status='acked',recovery=(recovery#-'{effects,afterReply}')#-'{effects,deliveredReply}',next_check_at=case when review_required and review_reason is not null
          and review_notified_at is null then now() end,updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='project' then
      if r.status in ('preparing','planned') then
        if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until is null or r.generation_until<=now() then
          return jsonb_build_object('conflict','ordinary_reply_fence_lost');
        end if;
      elsif r.status not in ('settled','acked') then return jsonb_build_object('conflict','reply_not_settled'); end if;
      update public.agent_reply_turns set projection_status='complete',updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id and projection_status='pending' returning * into r;
      if r.logical_turn_id is null then select * into r from public.agent_reply_turns where corp_id=v_corp and logical_turn_id=p_input->>'logicalTurnId'; end if;
    elsif p_operation='close_model_outage' then
      if r.owner is null or r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if r.review_reason='model_unavailable_before_tools' and r.status in ('settled','acked') then
        return jsonb_build_object('turn',to_jsonb(r));
      end if;
      if r.status<>'preparing' or r.projection_status<>'none' or r.mode<>'execute' then
        return jsonb_build_object('conflict','reply_outage_not_applicable');
      end if;
      update public.agent_reply_turns set status='settled',projection_status='complete',review_required=true,
        review_reason='model_unavailable_before_tools',delivery_result='{"outcome":"incomplete","accepted":0,"total":0}'::jsonb,
        recovery=recovery||jsonb_build_object('failure',jsonb_build_object(
          'stage','generation','cause','model_unavailable','models',p_input->'models','executedTools',0)),
        next_check_at=now(),updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    elsif p_operation='record_failure' then
      if r.owner is not null and r.owner=p_input->>'owner' and r.fence=(p_input->>'fence')::integer
        and r.projection_status='none' and r.recovery->'failure' is null then
        update public.agent_reply_turns set recovery=recovery||jsonb_build_object('failure',p_input->'failure'),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='request_review' then
      if r.mode<>'execute' or r.status not in ('settled','acked') then
        return jsonb_build_object('conflict','review_requires_closed_generation');
      end if;
      if r.review_reason is null then
        if p_input->>'reviewReason' is null or p_input->>'reviewReason' not in
          ('business_effects_unconfirmed','ordinary_reply_interrupted_no_resend','recovery_deadline') then
          return jsonb_build_object('conflict','invalid_review_reason');
        end if;
        update public.agent_reply_turns set review_required=true,review_reason=p_input->>'reviewReason',next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='review_notified' then
      if r.review_required and r.review_reason=p_input->>'reviewReason' and r.review_notified_at is null then
        update public.agent_reply_turns set review_notified_at=now(),recovery_attempts=0,
          next_check_at=case when status<>'acked' and projection_status<>'none' then now() end,updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='resolve_review' then
      -- Service-role operator supplies checked external evidence and the minimal local projection.
      -- No text generation, external dispatch or inference from the absence of an action row.
      if nullif(btrim(p_input->>'verifiedBy'),'') is null or nullif(btrim(p_input->>'evidenceRef'),'') is null then
        return jsonb_build_object('conflict','verified_business_effects_required');
      end if;
      if not r.review_required and r.recovery->'verification'->>'by'=p_input->>'verifiedBy'
        and r.recovery->'verification'->>'evidenceRef'=p_input->>'evidenceRef' and
          (r.recovery->'effects'=p_input->'effects' or (not (p_input ? 'effects') and r.review_reason<>'business_effects_unconfirmed')) then
        return jsonb_build_object('turn',to_jsonb(r));
      end if;
      if r.review_required and r.status='acked' and r.projection_status='complete' and not (p_input ? 'effects')
        and r.review_reason in ('model_unavailable_before_tools','ordinary_reply_interrupted_no_resend','recovery_deadline') then
        update public.agent_reply_turns set review_required=false,next_check_at=null,updated_at=now(),
          recovery=(recovery-array['replySegments','resumeUntil'])||jsonb_build_object('verification',jsonb_build_object('by',p_input->>'verifiedBy','evidenceRef',p_input->>'evidenceRef','at',now()))
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
        return jsonb_build_object('turn',to_jsonb(r));
      end if;
      if r.status<>'settled' or r.review_reason is distinct from 'business_effects_unconfirmed'
        or not r.review_required or r.projection_status<>'none'
        or jsonb_typeof(p_input->'effects'->'toolCalls') is distinct from 'array'
        or p_input->'effects'->'context'->>'logicalTurnId' is distinct from r.logical_turn_id
        or p_input->'effects'->'context'->>'traceId' is distinct from r.logical_turn_id
        or p_input->'effects'->'context'->>'chatId' is distinct from r.chat_id
        or p_input->'effects'->'context'->>'corpId' is distinct from r.corp_id
        or (p_input->'effects'->'context'->>'inputOccurredAt')::timestamptz is distinct from r.input_occurred_at
        or nullif(btrim(p_input->'effects'->'context'->>'userId'),'') is null
        or jsonb_typeof(p_input->'effects'->'context'->'isGroupChat') is distinct from 'boolean' then
        return jsonb_build_object('conflict','verified_business_effects_required');
      end if;
      if jsonb_array_length(p_input->'effects'->'toolCalls')>32 or exists (
        select 1 from jsonb_array_elements(p_input->'effects'->'toolCalls') as items(item)
        where coalesce(item->>'toolName','') not in ('duliday_interview_booking','duliday_cancel_work_order','duliday_modify_interview_time','invite_to_group')
          or jsonb_typeof(item->'args') is distinct from 'object'
          or jsonb_typeof(item->'result'->'success') is distinct from 'boolean'
          or exists (select 1 from (values (item->'args'->'workOrderId'),(item->'result'->'workOrderId')) as ids(id)
            where id is not null and (jsonb_typeof(id)<>'number' or id::text !~ '^[1-9][0-9]*$'))
      ) then return jsonb_build_object('conflict','invalid_business_effects'); end if;
      update public.agent_reply_turns set review_required=false,projection_status='pending',recovery_attempts=0,
        recovery=recovery||jsonb_build_object('effects',p_input->'effects','verification',jsonb_build_object(
          'by',p_input->>'verifiedBy','evidenceRef',p_input->>'evidenceRef','at',now())),
        next_check_at=now(),updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    elsif p_operation='defer' then
      -- An expired or superseded scanner (including a rolled-back binary) cannot
      -- postpone another worker's opportunity to take over the original plan.
      if r.status in ('preparing','planned') and r.recovery ? 'replySegments' and
        (r.generation_until<=now() or r.owner is distinct from p_input->>'owner'
         or r.fence is distinct from (p_input->>'fence')::integer) then
        return jsonb_build_object('turn',to_jsonb(r));
      end if;
      if r.next_check_at is not null then
        update public.agent_reply_turns set recovery_attempts=least(recovery_attempts+1,6),
          -- A callback may wake a still-leased turn. Recheck as soon as takeover
          -- is allowed, even if previous checks accumulated a long backoff.
          next_check_at=case when status in ('preparing','planned') and recovery ? 'replySegments'
            then case when fence=1 then generation_until else least(generation_until,v_resume_until) end
            else greatest(case when status in ('preparing','planned') then generation_until end,
              now()+make_interval(mins=>least(30,1<<least(recovery_attempts,5)))) end,updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    else raise exception 'unknown reply transition'; end if;
  end if;
  return jsonb_build_object('turn',case when r.logical_turn_id is null then null else to_jsonb(r) end);
end $$;
revoke all on function public.transition_agent_reply_turn(text,jsonb) from public,anon,authenticated;
grant execute on function public.transition_agent_reply_turn(text,jsonb) to service_role;
commit;
