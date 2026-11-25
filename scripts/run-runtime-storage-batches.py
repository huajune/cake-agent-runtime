"""Scan bounded keyset pages. Append stdout to a private JSONL file to retain the receipts."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def run_sql(script, **variables):
    command = ["psql", "-X", "-qAtw", "-v", "ON_ERROR_STOP=1"]
    for key, value in variables.items():
        command.extend(["-v", f"{key}={value}"])
    command.extend(["-f", str(Path(__file__).with_name(script))])
    return json.loads(subprocess.check_output(command, text=True))


def report(value):
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["action", "chat"])
    parser.add_argument("--after", default="null", help="next_after JSON from the last completed page")
    parser.add_argument("--pages", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--apply", action="store_true", help="compact eligible keys after recording each audit")
    args = parser.parse_args()
    if args.pages < 1 or not 1 <= args.batch_size <= 100:
        parser.error("pages must be positive and batch size must be between 1 and 100")
    after = json.loads(args.after)
    for _ in range(args.pages):
        audit = run_sql("audit-runtime-storage.sql", kind=args.kind, after=json.dumps(after),
                        batch_size=args.batch_size)
        report({"phase": "audit", "kind": args.kind, "after": after, **audit})
        if audit["broken"]:
            sys.exit("Broken references found; retain this page and investigate before resuming")
        outcome = {"candidates": len(audit["eligible_keys"]), "changed": 0, "changed_keys": [], "skipped": {}}
        if args.apply and audit["eligible_keys"]:
            outcome = run_sql("compact-runtime-storage.sql", keys=json.dumps(audit["eligible_keys"]))
        if audit["scanned"]:
            after = audit["next_after"]
        done = audit["scanned"] < args.batch_size
        report({"phase": "complete", "kind": args.kind, "applied": args.apply,
                "next_after": after, "done": done, **outcome})
        if done:
            break


if __name__ == "__main__":
    main()
