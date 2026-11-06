"""Actual concurrent PostgreSQL input ownership; isolated Docker fixture only."""
import concurrent.futures
import json
import re
import subprocess
import sys
import threading

container, database = sys.argv[1:]
assert re.fullmatch(r'cake-runtime-pg-[\w-]+', container)
assert re.fullmatch(r'cake_projection_[\w]+', database)
base = ['docker', 'exec', '-i', container, 'psql', '-X', '-q', '-At', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1']
barrier = threading.Barrier(2)

def claim(index):
    barrier.wait(timeout=10)
    statement = f"""begin; set local statement_timeout='5s';
    select public.transition_agent_reply_turn('open',jsonb_build_object(
      'corpId','ordinary-concurrency','accountId','bot','chatId','chat',
      'logicalTurnId','turn-{index}','inputIds',jsonb_build_array('same-input'),
      'inputOccurredAt',now(),'mode','execute','owner','owner-{index}',
      'deliveryPolicy','single_pass','recovery',jsonb_build_object('primary',jsonb_build_object('chatId','chat'))));
    select pg_sleep(0.2); commit;"""
    output = subprocess.run(base, input=statement, text=True, capture_output=True, timeout=15, check=True).stdout
    return json.loads(next(line for line in output.splitlines() if line.startswith('{')))

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(claim, [1, 2]))
assert sum('turn' in result for result in results) == 1, results
assert sum(result.get('conflict') == 'ordinary_reply_owned_elsewhere' for result in results) == 1, results
subprocess.run(base, input="delete from agent_reply_inputs where corp_id='ordinary-concurrency'; delete from agent_reply_turns where corp_id='ordinary-concurrency';", text=True, capture_output=True, timeout=10, check=True)
print('PASS: concurrent duplicate input has exactly one owner; second worker cannot generate or dispatch')
