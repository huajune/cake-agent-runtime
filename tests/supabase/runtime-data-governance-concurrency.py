"""Run only against a disposable, network-isolated database with the full migration chain."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import re
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("container")
parser.add_argument("database")
args = parser.parse_args()
if not re.fullmatch(r"cake-runtime-pg-[A-Za-z0-9_-]+", args.container) or not re.fullmatch(
    r"cake_projection_[A-Za-z0-9_]+", args.database
):
    parser.error("A disposable Cake PostgreSQL fixture is required")
config = json.loads(subprocess.check_output(["docker", "inspect", args.container]))[0]["HostConfig"]
assert config["NetworkMode"] == "none" and not config.get("PortBindings")
run = uuid.uuid4().hex
base = ["docker", "exec", "-i", args.container, "psql", "-XAtq", "-v", "ON_ERROR_STOP=1",
        "-U", "postgres", "-d", args.database]

def query(sql):
    result = subprocess.run(base, input=sql, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()

def parallel(statements):
    with ThreadPoolExecutor(max_workers=len(statements)) as executor:
        return list(executor.map(query, statements))

ticket = {"corp_id": run, "bot_im_id": "test-bot", "chat_id": run, "reason_code": "test",
          "created_at": "2026-11-18T12:00:00Z"}

def handoff(key):
    data = json.dumps(dict(ticket, idempotency_key=key))
    return f"select public.record_handoff('{data}','agent_tool',null,null);"

duplicates = parallel([handoff("same")] * 6)
assert duplicates.count("inserted") == 1 and duplicates.count("duplicate") == 5, duplicates
assert parallel([handoff(f"independent-{i}") for i in range(6)]) == ["inserted"] * 6
assert query(f"select count(*)=7 and count(distinct sequence_no)=7 from handoff_events where corp_id='{run}'") == "t"
assert query(f"select handoff_count from daily_ops_report where corp_id='{run}'") == "7"

# Whichever request wins, its snapshot and tool array must describe the same write.
switch = "insert into system_config(key,value) values('runtime_storage_writes','{\"response_tools\":true}') on conflict(key) do update set value=excluded.value;"
query(switch)
def snapshot(i):
    calls = [{"toolCallId": f"attempt-{i}", "name": "lookup", "result": "x" * 100}]
    record = dict(message_id=run, chat_id=run, received_at="2026-11-18T12:00:00Z", status="success", tool_calls=calls)
    invocation = {"request": {"attempt": i}, "response": {"toolCalls": calls}}
    return f"select save_processing_snapshot('{json.dumps(record)}','{json.dumps(invocation)}');"
assert parallel([snapshot(i) for i in range(8)]) == ["t"] * 8
assert query(f"""select m.invocation_version=i.write_version and
  public.processing_read_invocation(i)#>'{{response,toolCalls}}'=m.tool_calls and
  m.tool_calls#>>'{{0,toolCallId}}'='attempt-'||(i.agent_invocation#>>'{{request,attempt}}')
  from message_processing_records m join message_processing_invocations i using(message_id)
  where m.message_id='{run}';""") == "t"
print("PASS concurrent duplicate and independent handoffs, daily counts, and eight overlapping snapshot writes")
