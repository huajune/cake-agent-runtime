-- Uses the actual pre-existing upsert_ops_event and daily_ops_report, not a stub.
BEGIN;
DO $$
DECLARE r jsonb; e ops_events%ROWTYPE; total_count integer;
BEGIN
 r := upsert_ops_event(p_corp_id=>'cold-events',p_event_name=>'booking.succeeded',
   p_idempotency_key=>'91',p_occurred_at=>'2026-10-19T15:59:00Z',p_bot_im_id=>'bot',
   p_payload=>'{"work_order_id":91,"brand_name":"Original"}');
 ASSERT r->>'inserted'='true';
 r := upsert_ops_event(p_corp_id=>'cold-events',p_event_name=>'booking.succeeded',
   p_idempotency_key=>'91',p_occurred_at=>'2026-10-21T15:59:00Z',p_bot_im_id=>'bot',
   p_payload=>'{"work_order_id":91,"brand_name":"Wrong replay"}');
 ASSERT r->>'inserted'='false';
 PERFORM upsert_ops_event(p_corp_id=>'cold-other-corp',p_event_name=>'booking.succeeded',
   p_idempotency_key=>'91',p_occurred_at=>'2026-10-19T15:59:00Z',p_bot_im_id=>'bot');
 ASSERT enrich_booking_invite_event('cold-events','91','{"outcome":"unknown","token":"DROP","brand_name":"WRONG"}');
 ASSERT enrich_booking_invite_event('cold-events','91','{"outcome":"invited","attempted":true,"success":true,"group_name":"Group"}');
 ASSERT enrich_booking_invite_event('cold-events','91','{"outcome":"unknown","success":false}');
 SELECT * INTO STRICT e FROM ops_events WHERE corp_id='cold-events' AND event_name='booking.succeeded' AND idempotency_key='91';
 ASSERT e.payload#>>'{group_invite,outcome}'='invited';
 ASSERT e.payload#>>'{group_invite,success}'='true';
 ASSERT e.payload#>'{group_invite,token}' IS NULL;
 ASSERT e.payload->>'brand_name'='Original';
 ASSERT e.occurred_at='2026-10-19T15:59:00Z'::timestamptz AND e.report_date='2026-10-19';
 ASSERT (SELECT booking_success_count FROM daily_ops_report WHERE corp_id='cold-events' AND report_date='2026-10-19' AND bot_im_id='bot')=1;
 ASSERT NOT EXISTS(SELECT FROM daily_ops_report WHERE corp_id='cold-events' AND report_date='2026-10-21');
 ASSERT NOT EXISTS(SELECT FROM ops_events WHERE corp_id='cold-other-corp' AND payload ? 'group_invite');
 ASSERT NOT enrich_booking_invite_event('cold-missing','91','{"outcome":"invited"}');
 PERFORM upsert_ops_event(p_corp_id=>'cold-events',p_event_name=>'booking.canceled',
   p_idempotency_key=>'91:canceled',p_occurred_at=>'2026-10-19T15:59:00Z',p_bot_im_id=>'bot');
 PERFORM upsert_ops_event(p_corp_id=>'cold-events',p_event_name=>'booking.interview_modified',
   p_idempotency_key=>'91:interview_modified:2026-10-22 09:00:00',p_occurred_at=>'2026-10-19T15:59:00Z',p_bot_im_id=>'bot');
 ASSERT (SELECT booking_cancel_count=1 AND interview_modified_count=1 FROM daily_ops_report WHERE corp_id='cold-events' AND bot_im_id='bot');
 ASSERT NOT has_function_privilege('anon','enrich_booking_invite_event(text,text,jsonb)','execute');
 ASSERT NOT has_function_privilege('authenticated','enrich_booking_invite_event(text,text,jsonb)','execute');
 ASSERT has_function_privilege('service_role','enrich_booking_invite_event(text,text,jsonb)','execute');
END $$;
ROLLBACK;
