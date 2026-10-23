-- Isolated PostgreSQL only. All test records roll back.
begin;
do $$
declare
  p jsonb := jsonb_build_object('corpId','review-test','actionId','review-action','requestId','request',
    'resourceHash','resource','payloadHash','hash','mode','execute','recoveryDeadline',now()+interval '1 day',
    'intent',jsonb_build_object('accountId','account','chatId','chat','logicalTurnId','turn','kind','booking',
      'occurredAt',now(),'parameters','{}'::jsonb));
  review jsonb := '{"corpId":"review-test","actionId":"review-action","accountId":"account","payloadHash":"hash","dispatchAttemptId":"attempt","operator":"test-operator","basis":"provider-support-case:test-001","conclusion":"succeeded","completion":{"status":"succeeded","result":{"workOrderId":42},"evidence":{"kind":"completed","requestTerminated":true}}}';
  r jsonb;
  rejected boolean;
begin
  perform public.transition_agent_action('prepare',p);
  perform public.transition_agent_action('claim','{"corpId":"review-test","actionId":"review-action","owner":"attempt"}');
  rejected:=false;
  begin perform public.review_agent_action(review-'operator'); exception when others then rejected:=true; end;
  assert rejected, 'review without operator must fail';
  rejected:=false;
  begin perform public.review_agent_action(review||'{"dispatchAttemptId":"wrong-attempt"}'); exception when others then rejected:=true; end;
  assert rejected, 'review must bind the original attempt';
  rejected:=false;
  begin perform public.review_agent_action(jsonb_set(review,'{completion,evidence,requestTerminated}','false')); exception when others then rejected:=true; end;
  assert rejected, 'goal satisfaction is not terminal evidence';
  r:=public.review_agent_action(review);
  assert r->>'status'='succeeded' and r->>'local_sync'='pending';
  assert not (r->>'retryable')::boolean;
  assert (select count(*)=1 from public.agent_action_reviews where corp_id='review-test');
  rejected:=false;
  begin perform public.review_agent_action(review||'{"conclusion":"failed"}'); exception when others then rejected:=true; end;
  assert rejected, 'terminal success cannot be downgraded by an operator';
  r:=public.review_agent_action(review||'{"conclusion":"retry_local_sync"}');
  assert r->>'status'='succeeded' and (r->>'attempts')::integer=0;
  perform public.transition_agent_action('claim','{"corpId":"review-test","actionId":"review-action","owner":"must-not-dispatch"}');
  assert (select status='succeeded' and owner is null from public.agent_action_records where corp_id='review-test');
  assert not has_function_privilege('authenticated','public.review_agent_action(jsonb)','execute');
  assert not has_table_privilege('service_role','public.agent_action_reviews','update');
end $$;
rollback;
