"""Cold-load actual Cake memory/ops migrations, then runtime SQL, in isolated Docker PG only."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[3])
parser.add_argument('--container', required=True)
parser.add_argument('--database', default='cake_projection_runtime_' + datetime.datetime.now().strftime('%Y%m%d%H%M%S'))
parser.add_argument('--delivery-ref', help='Exact local Git commit containing final D migration/tests; omit on merged checkout')
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--baseline-only', action='store_true', help='Validate real old dependencies before D final is ready')
args = parser.parse_args()
if not re.fullmatch(r'cake-runtime-pg-[a-zA-Z0-9_-]+', args.container):
    sys.exit('Only the explicitly isolated cake-runtime-pg-* container is permitted')
if not re.fullmatch(r'cake_projection_[a-zA-Z0-9_]+', args.database):
    sys.exit('Only a fresh cake_projection_* database is permitted')
args.output.mkdir(parents=True, exist_ok=False)

def command(argv, data=None):
    result = subprocess.run(argv, input=data, text=True, capture_output=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f'{argv!r}\n{result.stdout}\n{result.stderr}')
    return result.stdout

inspection = json.loads(command(['docker', 'inspect', args.container]))[0]
assert inspection['HostConfig']['NetworkMode'] == 'none', 'Container must have no network'
assert not inspection['HostConfig'].get('PortBindings'), 'Container must publish no ports'
base = ['docker', 'exec', '-i', '-e', 'PGOPTIONS=-c statement_timeout=10000 -c lock_timeout=5000',
        args.container, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-d', args.database]
command(['docker', 'exec', args.container, 'createdb', '-U', 'postgres', args.database])
manifest = {'database': args.database, 'container': args.container, 'sources': []}
manifest['postgres'] = command(base + ['-Atc', 'SELECT version()']).strip()
manifest['repositoryCommit'] = command(['git', '-C', str(args.repo), 'rev-parse', 'HEAD']).strip()

def apply(label, sql):
    path = args.output / label
    path.write_text(sql)
    result = command(base, sql)
    path.with_suffix(path.suffix + '.log').write_text(result)
    print('PASS', label, flush=True)

def source(path, delivery=False):
    if delivery and args.delivery_ref:
        content = command(['git', '-C', str(args.repo), 'show', f'{args.delivery_ref}:{path}'])
        origin = args.delivery_ref
    else:
        content = (args.repo / path).read_text()
        origin = 'checkout'
    manifest['sources'].append({'path': path, 'origin': origin, 'sha256': hashlib.sha256(content.encode()).hexdigest()})
    return content

# Only the Supabase authentication SQL shim is supplied locally; all business schemas
# and RPC bodies below are loaded unchanged from repository migrations.
apply('000-local-auth.sql', """
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
   nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role')
$$;
""")
baseline = source('supabase/migrations/20260310000000_baseline.sql')
# Byte-for-byte prefix contains the original sequences, complete chat_messages and
# message_processing_records definitions. Exclude unrelated monitoring/system tables.
prefix = baseline.split('-- 2.3 monitoring_hourly_stats', 1)
assert len(prefix) == 2 and 'CREATE TABLE IF NOT EXISTS message_processing_records' in prefix[0]
apply('001-baseline-required-tables.sql', prefix[0])

old = [
 '20260527120000_create_agent_long_term_memories.sql',
 '20260529150000_create_ops_data_foundation.sql',
 '20260608120000_ops_workorder_mutation_events.sql',
 '20260610120000_settled_boundary_by_session.sql',
 '20260610120100_mark_settled_boundary_fn.sql',
 '20260610130000_add_preference_facts_column.sql',
 '20260630120000_rename_latest_booking_to_active_booking.sql',
 '20260707150000_atomic_settlement_facts_upsert.sql',
 '20260821210000_rename_long_term_columns_coala.sql',
 '20260825025701_add_long_term_bot_account_dimension.sql',
 '20260825050239_flatten_session_summaries_and_move_consolidation_watermarks.sql',
 '20260825055058_extend_long_term_profile_height_weight.sql',
 '20260825063752_fix_atomic_episodic_lazy_migration.sql',
 '20260911120000_flatten_legacy_long_term_shapes.sql',
]
for name in old:
    apply(name, source('supabase/migrations/' + name))

if args.baseline_only:
    (args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print('PASS: real legacy schema and RPC dependencies cold-loaded; runtime checks intentionally deferred')
    sys.exit(0)

new = [
 '20261021090000_agent_action_records.sql',
 '20261021093000_action_ops_event_projection.sql',
 '20261021100000_reply_turns.sql',
 '20261021110000_booking_poll_seek_index.sql',
 '20261021130000_version_booking_projections.sql',
 '20261023060000_runtime_retention_batches.sql',
]
for name in new:
    apply(name, source('supabase/migrations/' + name, delivery='reply_turns' in name))

for path in [
 'tests/biz/action-execution/action-records.postgres.sql',
 'tests/biz/action-execution/action-review.postgres.sql',
 'tests/biz/action-execution/action-retention.postgres.sql',
 'tests/biz/action-execution/booking-projection.postgres.sql',
 'tests/biz/reply-execution/reply-turns.integration.sql',
]:
    apply(Path(path).name, source(path, delivery='reply-execution' in path))
apply('action-ops-projection.integration.sql', source('tests/biz/action-execution/action-ops-projection.integration.sql'))

for path, argv in [
 ('tests/biz/action-execution/action-records-concurrency.py', [args.container, args.database]),
 ('tests/biz/action-execution/booking-projection-concurrency.py', ['--container', args.container, '--database', args.database]),
]:
    script = args.output / Path(path).name
    script.write_text(source(path))
    result = command([sys.executable, str(script), *argv])
    script.with_suffix('.log').write_text(result)
    print(result.strip(), flush=True)

(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2))
print('PASS: cold dependency chain, runtime migrations, SQL fault/permission assertions, and real concurrent transaction checks')
print('Results:', args.output)
print('Database retained for inspection:', args.database)
