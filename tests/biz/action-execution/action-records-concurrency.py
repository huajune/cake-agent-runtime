"""Run against the isolated Docker PostgreSQL used by action-records.postgres.sql."""
import concurrent.futures
import json
import subprocess
import sys
import time

container = sys.argv[1] if len(sys.argv) == 2 else ''
if not container.startswith('cake-runtime-pg-'):
    raise SystemExit('Pass the explicitly isolated cake-runtime-pg-* test container')


def sql(statement):
    return subprocess.check_output(
        ['docker', 'exec', '-i', container, 'psql', '-U', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=1'],
        input=statement, text=True).strip()


def transition(op, data):
    encoded = json.dumps(data).replace("'", "''")
    return f"select public.transition_agent_action('{op}','{encoded}'::jsonb);"


base = {'corpId': 'test-concurrent', 'actionId': 'race', 'requestId': 'req', 'resourceHash': 'resource',
        'payloadHash': 'payload', 'mode': 'execute', 'recoveryDeadline': '2099-01-01T00:00:00Z',
        'intent': {'corpId': 'test-concurrent', 'accountId': 'account', 'chatId': 'chat',
                   'logicalTurnId': 'turn', 'kind': 'test', 'target': 'resource',
                   'occurredAt': '2026-10-21T00:00:00Z', 'parameters': {}}}
sql(transition('prepare', base))
try:
    first = transition('claim', {'corpId': base['corpId'], 'actionId': 'race', 'owner': 'first'})
    second = transition('claim', {'corpId': base['corpId'], 'actionId': 'race', 'owner': 'second'})
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        held = pool.submit(sql, 'begin;' + first + 'select pg_sleep(1);commit;')
        time.sleep(0.2)
        raced = pool.submit(sql, second)
        held.result()
        result = json.loads(raced.result())
    assert result['record']['owner'] == 'first'
    assert result['record']['fence'] == 1
    # cancel competes on the same row/resource lock and cannot cancel a claimed action.
    cancelled = json.loads(sql(transition('cancel', {'corpId': base['corpId'], 'actionId': 'race'})))
    assert cancelled['record']['status'] == 'executing'
    print('Concurrent claim and cancellation constraints passed')
finally:
    sql("delete from public.agent_action_records where corp_id='test-concurrent';")
