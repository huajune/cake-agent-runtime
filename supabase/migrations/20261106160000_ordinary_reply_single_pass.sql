-- Ordinary replies keep input ownership and a delivery summary, without a frozen text plan.
-- Defaults preserve proactive tasks and all older execute obligations, including on rollback.
alter table public.agent_reply_turns add column if not exists delivery_policy text not null default 'frozen';
alter table public.agent_reply_turns add column if not exists delivery_result jsonb;
alter table public.agent_reply_turns drop constraint if exists agent_reply_turns_delivery_policy_check;
alter table public.agent_reply_turns add constraint agent_reply_turns_delivery_policy_check check(delivery_policy in ('frozen','single_pass'));
alter table public.agent_reply_turns drop constraint if exists agent_reply_turns_single_pass_plan_check;
alter table public.agent_reply_turns add constraint agent_reply_turns_single_pass_plan_check check(delivery_policy<>'single_pass' or plan is null);
alter table public.agent_reply_turns drop constraint if exists agent_reply_turns_delivery_result_check;
alter table public.agent_reply_turns add constraint agent_reply_turns_delivery_result_check check(delivery_result is null or (
  jsonb_typeof(delivery_result)='object' and delivery_result ? 'outcome'
  and jsonb_typeof(delivery_result->'outcome')='string'
  and delivery_result->>'outcome' in ('complete','incomplete','unknown','skipped','interrupted')
  and (delivery_result->>'outcome'='interrupted' or (
    delivery_result ?& array['accepted','total']
    and jsonb_typeof(delivery_result->'accepted')='number' and jsonb_typeof(delivery_result->'total')='number'
    and (delivery_result->>'accepted')::integer>=0 and (delivery_result->>'total')::integer >= (delivery_result->>'accepted')::integer
  ))
));

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
      insert into public.agent_reply_turns(corp_id,account_id,chat_id,logical_turn_id,input_ids,input_occurred_at,mode,owner,generation_until,recovery,next_check_at,projection_status,projection_next_check_at,delivery_policy)
        values(v_corp,v_account,v_chat,p_input->>'logicalTurnId',v_ids,(p_input->>'inputOccurredAt')::timestamptz,v_mode,p_input->>'owner',now()+interval '10 minutes',coalesce(p_input->'recovery','{}'),now()+interval '10 minutes',
          case when p_input->'recovery'->'task'->>'kind'='reengagement' then 'pending' else 'none' end,
          case when p_input->'recovery'->'task'->>'kind'='reengagement' then now()+interval '10 minutes' else null end,
          coalesce(p_input->>'deliveryPolicy','frozen')) returning * into r;
      insert into public.agent_reply_inputs(corp_id,account_id,chat_id,message_id,logical_turn_id)
        select v_corp,v_account,v_chat,unnest(v_ids),r.logical_turn_id;
    elsif r.delivery_policy='single_pass' and r.status in ('preparing','planned') then
      -- A second worker may close an expired input, never regenerate or resume its text.
      if r.generation_until>now() then return jsonb_build_object('conflict','ordinary_reply_owned_elsewhere'); end if;
      update public.agent_reply_turns set status='settled',delivery_result=jsonb_build_object('outcome','interrupted'),
        review_required=true,next_check_at=now(),updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
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
    if p_operation='save_effects' then
      if r.delivery_policy<>'single_pass' or r.status<>'preparing' or r.owner is distinct from p_input->>'owner'
        or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if r.recovery->'effects' is not null and r.recovery->'effects'<>p_input->'effects' then
        return jsonb_build_object('conflict','immutable_business_effects');
      end if;
      update public.agent_reply_turns set recovery=recovery||jsonb_build_object('effects',p_input->'effects'),
        projection_status='pending',updated_at=now() where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
    elsif p_operation='check_input' then
      if r.delivery_policy<>'single_pass' or r.status not in ('preparing','planned') or r.owner is null or
        r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
    elsif p_operation in ('start_delivery','check_delivery') then
      if r.delivery_policy<>'single_pass' or r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer
        or r.generation_until<=now() or r.status<>(case when p_operation='start_delivery' then 'preparing' else 'planned' end) then
        return jsonb_build_object('conflict','ordinary_reply_fence_lost');
      end if;
      if p_operation='start_delivery' then
        update public.agent_reply_turns set status='planned',generation_until=now()+interval '10 minutes',next_check_at=now()+interval '10 minutes',updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='interrupt' then
      if r.delivery_policy<>'single_pass' then return jsonb_build_object('conflict','frozen_obligation_requires_recovery'); end if;
      if r.status in ('preparing','planned') then
        if r.generation_until>now() then return jsonb_build_object('conflict','ordinary_reply_still_owned'); end if;
        update public.agent_reply_turns set status='settled',delivery_result=jsonb_build_object('outcome','interrupted'),
          review_required=true,next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='plan' then
      if r.delivery_policy='single_pass' then return jsonb_build_object('conflict','ordinary_reply_plan_forbidden'); end if;
      if r.plan is not null and r.plan<>p_input->'plan' then return jsonb_build_object('conflict','immutable_reply_plan'); end if;
      if r.status='preparing' then
        if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then return jsonb_build_object('conflict','generation_fence_lost'); end if;
        update public.agent_reply_turns set plan=p_input->'plan',status='planned',next_check_at=now()+interval '1 minute',updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='settle' then
      if r.delivery_policy='single_pass' and r.status in ('preparing','planned') then
        if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
          return jsonb_build_object('conflict','ordinary_reply_fence_lost');
        end if;
        update public.agent_reply_turns set status='settled',
          delivery_result=coalesce(nullif(p_input->'deliveryResult','null'::jsonb),jsonb_build_object('outcome','skipped','accepted',0,'total',0)),
          next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      -- Frozen obligations still require every segment's terminal evidence.
      elsif r.status='planned' then
        if exists(select 1 from jsonb_array_elements(r.plan->'segments') s left join public.agent_action_records a
          on a.corp_id=v_corp and a.action_id=s->>'actionId' and a.account_id=r.account_id and a.chat_id=r.chat_id and a.logical_turn_id=r.logical_turn_id
          where a.action_id is null or not (a.status in ('succeeded','cancelled') or
            (a.status='failed' and not a.retryable and coalesce(a.evidence->>'kind','')='definitive_no_effect'
              and coalesce(a.evidence->>'requestTerminated','')='true'
              and coalesce(a.evidence->>'detail','')='permission_changed_before_dispatch'))) then
          return jsonb_build_object('conflict','unresolved_reply_segments');
        end if;
        update public.agent_reply_turns set status='settled',next_check_at=now(),updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='ack' then
      if r.delivery_policy='single_pass' and r.projection_status='pending' then return jsonb_build_object('conflict','business_effects_pending'); end if;
      if r.status not in ('settled','acked') then return jsonb_build_object('conflict','reply_not_settled'); end if;
      if r.status='settled' then
        update public.agent_reply_turns set status='acked',next_check_at=null,updated_at=now()
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      end if;
    elsif p_operation='project' then
      if r.delivery_policy='single_pass' and r.status in ('preparing','planned') then
        if r.owner is distinct from p_input->>'owner' or r.fence is distinct from (p_input->>'fence')::integer or r.generation_until<=now() then
          return jsonb_build_object('conflict','ordinary_reply_fence_lost');
        end if;
      elsif r.status not in ('settled','acked') then return jsonb_build_object('conflict','reply_not_settled'); end if;
      update public.agent_reply_turns set projection_status='complete',projection_next_check_at=null,updated_at=now()
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id and projection_status='pending' returning * into r;
      if r.logical_turn_id is null then select * into r from public.agent_reply_turns where corp_id=v_corp and logical_turn_id=p_input->>'logicalTurnId'; end if;
    elsif p_operation='defer_projection' then
      update public.agent_reply_turns set projection_next_check_at=now()+case when input_occurred_at<now()-interval '1 day' then interval '1 hour' else interval '1 minute' end
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id and projection_status='pending' returning * into r;
      if r.logical_turn_id is null then select * into r from public.agent_reply_turns where corp_id=v_corp and logical_turn_id=p_input->>'logicalTurnId'; end if;
    elsif p_operation='defer' then
      if r.status in ('preparing','planned','settled') then
      if r.delivery_policy='single_pass' then
        update public.agent_reply_turns set next_check_at=case when status='settled' then now()+interval '1 minute' else greatest(generation_until,now()+interval '1 minute') end
          where corp_id=v_corp and logical_turn_id=r.logical_turn_id returning * into r;
      else
      update public.agent_reply_turns set review_required=(status='preparing' or (status='planned' and input_occurred_at<now()-interval '1 day')),
        next_check_at=case when status='preparing' or (status='planned' and input_occurred_at<now()-interval '1 day') then null else now()+interval '1 minute' end
        where corp_id=v_corp and logical_turn_id=r.logical_turn_id and status in ('preparing','planned','settled') returning * into r;
      end if;
      end if;
    else raise exception 'unknown reply transition'; end if;
  end if;
  return jsonb_build_object('turn',case when r.logical_turn_id is null then null else to_jsonb(r) end);
end $$;
revoke all on function public.transition_agent_reply_turn(text,jsonb) from public,anon,authenticated;
grant execute on function public.transition_agent_reply_turn(text,jsonb) to service_role;
