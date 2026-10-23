import argparse
import subprocess

parser = argparse.ArgumentParser(description="Isolated PostgreSQL projection race checks; no business database")
parser.add_argument("--container", required=True)
parser.add_argument("--database", default="cake_projection_review")
args = parser.parse_args()
if not args.container.startswith("cake-runtime-pg-") or not args.database.startswith("cake_projection_"):
    raise SystemExit("Only isolated cake-runtime-pg-* / cake_projection_* targets are permitted")
base=['docker','exec','-i',args.container,'psql','-X','-q','-U','postgres','-d',args.database,'-v','ON_ERROR_STOP=1']
def run(sql):
    p=subprocess.run(base,input=sql,text=True,capture_output=True)
    if p.returncode: raise RuntimeError(p.stderr)
    return p.stdout

def race(sql_a,sql_b,assertion):
    a=subprocess.Popen(base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    a.stdin.write('BEGIN;\n'+sql_a+';\n\\echo LOCKED\nSELECT pg_sleep(0.8);\nCOMMIT;\n')
    a.stdin.close()
    for line in a.stdout:
        if 'LOCKED' in line: break
    run(sql_b)
    if a.wait(): raise RuntimeError(a.stderr.read())
    run(assertion)

race("SELECT apply_active_booking_projection('race-test','same-order','set',1,'2026-10-21 02:00Z',1,'new')", "SELECT apply_active_booking_projection('race-test','same-order','set',1,'2026-10-21 01:00Z',1,'old');", "DO $$ BEGIN ASSERT (SELECT active_booking->>'interview_time' FROM agent_long_term_memories WHERE corp_id='race-test' AND user_id='same-order')='new'; END $$;")
race("SELECT apply_active_booking_projection('race-test','two-orders','set',1,'2026-10-21 01:00Z',1,'first')", "SELECT apply_active_booking_projection('race-test','two-orders','set',2,'2026-10-21 02:00Z',2,'second');", "DO $$ BEGIN ASSERT (SELECT jsonb_array_length(active_booking->'bookings') FROM agent_long_term_memories WHERE corp_id='race-test' AND user_id='two-orders')=2; END $$;")
race("SELECT apply_active_booking_projection('race-test','cancel-race','clear',1,'2026-10-21 03:00Z')", "SELECT apply_active_booking_projection('race-test','cancel-race','set',1,'2026-10-21 02:00Z',1,'old booking');", "DO $$ BEGIN ASSERT (SELECT active_booking IS NULL FROM agent_long_term_memories WHERE corp_id='race-test' AND user_id='cancel-race'); END $$;")
print('PASS: 3 real concurrent transaction cases (old modify, independent orders, cancellation tombstone).')
