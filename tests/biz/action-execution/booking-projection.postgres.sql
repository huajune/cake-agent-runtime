-- Isolated database only. Apply 20261021130000_version_booking_projections.sql first.
BEGIN;
DO $$
DECLARE r jsonb; b jsonb;
BEGIN
  -- New time wins over an old repair even if the provider's current list lags.
  PERFORM apply_active_booking_projection('projection-test','person','set',21,'2026-10-21 02:00Z',11,'2026-10-24 15:00');
  r := apply_active_booking_projection('projection-test','person','set',21,'2026-10-21 01:00Z',11,'2026-10-23 10:00');
  ASSERT r->>'superseded'='true';
  SELECT active_booking INTO b FROM agent_long_term_memories WHERE corp_id='projection-test' AND user_id='person';
  ASSERT b->>'interview_time'='2026-10-24 15:00';
  -- An equal-version retry must not change a previously committed projection either.
  PERFORM apply_active_booking_projection('projection-test','person','set',21,'2026-10-21 02:00Z',11,'stale equal-version read');
  SELECT active_booking INTO b FROM agent_long_term_memories WHERE corp_id='projection-test' AND user_id='person';
  ASSERT b->>'interview_time'='2026-10-24 15:00';
  -- Cancellation writes a tombstone even if the pointer is absent.
  PERFORM apply_active_booking_projection('projection-test','person','clear',21,'2026-10-21 03:00Z');
  r := apply_active_booking_projection('projection-test','person','set',21,'2026-10-21 02:00Z',11,'resurrected');
  ASSERT r->>'superseded'='true';
  SELECT active_booking INTO b FROM agent_long_term_memories WHERE corp_id='projection-test' AND user_id='person';
  ASSERT b IS NULL;
  PERFORM apply_active_booking_projection('projection-test','person','clear',99,'2026-10-21 04:00Z');
  r := apply_active_booking_projection('projection-test','person','set',99,'2026-10-21 03:00Z',12,'resurrected absent');
  ASSERT r->>'superseded'='true';
  -- An old cancellation may not delete a newer fact for the same order.
  PERFORM apply_active_booking_projection('projection-test','person','set',21,'2026-10-21 05:00Z',11,'new version');
  r := apply_active_booking_projection('projection-test','person','clear',21,'2026-10-21 04:00Z');
  ASSERT r->>'superseded'='true';
  -- Candidate-wide reset leaves later facts, and prevents late old inserts for unknown IDs.
  PERFORM apply_active_booking_projection('projection-test','person','clear',NULL,'2026-10-21 04:30Z');
  r := apply_active_booking_projection('projection-test','person','set',100,'2026-10-21 04:00Z',12,'late unseen order');
  ASSERT r->>'superseded'='true';
  SELECT active_booking INTO b FROM agent_long_term_memories WHERE corp_id='projection-test' AND user_id='person';
  ASSERT b->>'work_order_id'='21';
  ASSERT b->>'interview_time'='new version';
  -- Other work orders survive changes to one order; list order and cap stay unchanged.
  PERFORM apply_active_booking_projection('projection-test','person','set',22,'2026-10-21 06:00Z',12,'second order');
  PERFORM apply_active_booking_projection('projection-test','person','clear',21,'2026-10-21 07:00Z');
  SELECT active_booking INTO b FROM agent_long_term_memories WHERE corp_id='projection-test' AND user_id='person';
  ASSERT jsonb_array_length(b->'bookings')=1;
  ASSERT b->>'work_order_id'='22';
  -- Pre-migration rows use the existing linked_at as their initial version.
  INSERT INTO agent_long_term_memories(corp_id,user_id,active_booking) VALUES('projection-test','legacy',
    '{"work_order_id":33,"linked_at":"2026-10-21T03:00:00Z","job_id":1,"interview_time":"new legacy time"}');
  r := apply_active_booking_projection('projection-test','legacy','set',33,'2026-10-21 02:00Z',1,'stale legacy time');
  ASSERT r->>'superseded'='true';
  -- A later external cancellation is already durable but its local tombstone has not run yet.
  INSERT INTO agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
    resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,recovery_deadline,status,result)
    VALUES('projection-test','new-cancel','bot','other-chat','later-turn','sponge.cancel',
      'work-order:77','payload','request','{"recovery":{"workOrderId":77}}',
      '2026-10-21 03:00Z','execute','2026-10-22 03:00Z','succeeded','{"success":true}');
  r := apply_active_booking_projection('projection-test','pending-cancel','set',77,'2026-10-21 02:00Z',1,'old booking');
  ASSERT r->>'superseded'='true';
  -- Late high-confidence identity fields must not replace newer high-confidence facts.
  PERFORM upsert_booking_profile_facts('projection-test','identity','bot',
    '{"name":{"value":"new person","confidence":"high","updatedAt":"2026-10-21T02:00:00Z"}}');
  PERFORM upsert_booking_profile_facts('projection-test','identity','bot',
    '{"name":{"value":"old person","confidence":"high","updatedAt":"2026-10-21T01:00:00Z"}}');
  SELECT semantic_profile INTO b FROM agent_long_term_memories
    WHERE corp_id='projection-test' AND user_id='identity' AND bot_user_id='bot';
  ASSERT b->'name'->>'value'='new person';
  ASSERT NOT has_function_privilege('anon','apply_active_booking_projection(text,text,text,bigint,timestamptz,bigint,text)','execute');
  ASSERT has_function_privilege('service_role','apply_active_booking_projection(text,text,text,bigint,timestamptz,bigint,text)','execute');
END;
$$;
ROLLBACK;
