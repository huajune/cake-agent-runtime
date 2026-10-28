"""Restart an isolated runtime PostgreSQL and verify frozen obligations survive.

Run after verify-runtime-postgres.py, passing its container and database.
No provider calls; synthetic fixture only. This is storage recovery, not channel acceptance.
"""
import argparse
import json
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--container', required=True)
parser.add_argument('--database', required=True)
args = parser.parse_args()
assert re.fullmatch(r'cake-runtime-pg-[\w-]+', args.container)
assert re.fullmatch(r'cake_projection_[\w]+', args.database)


def run(argv, data=None):
    return subprocess.run(argv, input=data, text=True, capture_output=True,
                          check=True, timeout=60).stdout


inspection = json.loads(run(['docker', 'inspect', args.container]))[0]
assert inspection['HostConfig']['NetworkMode'] == 'none'
assert not inspection['HostConfig'].get('PortBindings')
psql = ['docker', 'exec', '-i', args.container, 'psql', '-X', '-U', 'postgres',
        '-d', args.database, '-v', 'ON_ERROR_STOP=1']
run(psql, """
SET statement_timeout='5s';
DO $$ DECLARE base jsonb; p jsonb; BEGIN
  base:=jsonb_build_object('corpId','restart-drill','accountId','bot','chatId','chat',
    'logicalTurnId','original-turn','inputIds','["original-input"]'::jsonb,
    'inputOccurredAt',now(),'mode','execute','owner','original-owner');
  PERFORM transition_agent_reply_turn('open',base);
  PERFORM transition_agent_reply_turn('plan',base||jsonb_build_object('fence',1,'plan',
    '{"version":1,"text":"original reply","segments":[{"index":0,"text":"original reply","actionId":"reply","requestId":"request"}]}'::jsonb));
  p:=jsonb_build_object('corpId','restart-drill','actionId','reply','requestId','request',
    'resourceHash','resource','payloadHash','hash','mode','execute',
    'recoveryDeadline',now()+interval '1 day','intent',jsonb_build_object(
      'accountId','bot','chatId','chat','logicalTurnId','original-turn',
      'kind','wecom.reply_segment','parameters','{"text":"original reply"}'::jsonb,'occurredAt',now()));
  PERFORM transition_agent_action('prepare',p);
  PERFORM transition_agent_action('claim','{"corpId":"restart-drill","actionId":"reply","owner":"dispatch-before-crash"}');
  UPDATE agent_action_records SET next_check_at=now()-interval '1 second' WHERE corp_id='restart-drill';
END $$;
""")
run(['docker', 'restart', args.container])
run(['docker', 'exec', args.container, 'sh', '-c',
     'for n in 1 2 3 4 5; do pg_isready -U postgres && exit 0; sleep 1; done; exit 1'])
print(run(psql, """
SET statement_timeout='5s';
DO $$ DECLARE r jsonb; BEGIN
  r:=transition_agent_action('claim','{"corpId":"restart-drill","actionId":"reply","owner":"new-dispatch"}');
  ASSERT r->'record'->>'owner'='dispatch-before-crash','restart never authorizes redispatch';
  r:=transition_agent_action('reconcile_claim','{"corpId":"restart-drill","actionId":"reply","owner":"query-after-restart"}');
  ASSERT r->'record'->>'status'='unknown','expired execution only grants reconciliation';
  r:=transition_agent_reply_turn('open',jsonb_build_object('corpId','restart-drill','accountId','bot',
    'chatId','chat','logicalTurnId','different-turn','inputIds','["original-input","new-input"]'::jsonb,
    'inputOccurredAt',now(),'mode','observe','owner','after-restart'));
  ASSERT r->'turn'->>'logical_turn_id'='original-turn','rollback retains original turn';
  ASSERT r->'turn'->'input_ids'='["original-input"]'::jsonb,'new input not absorbed';
  ASSERT r->'turn'->'plan'->>'text'='original reply','original plan survives restart';
  ASSERT NOT agent_reply_plan_confirmed('restart-drill','original-turn');
  ASSERT NOT append_agent_reply_callback('{"corpId":"restart-drill","accountId":"wrong-bot","chatId":"chat","requestId":"request","messageId":"callback","text":"original reply","messageType":7}');
  ASSERT append_agent_reply_callback('{"corpId":"restart-drill","accountId":"bot","chatId":"chat","requestId":"request","messageId":"callback","text":"original reply","messageType":7}');
  ASSERT EXISTS(SELECT 1 FROM agent_action_evidence WHERE corp_id='restart-drill'), 'late callback persisted';
END $$;
"""))
print('PASS: actual database restart, no redispatch, rollback isolation, original input/plan, exact late callback evidence')
