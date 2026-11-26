"""FIFO estimate only. Input contains aggregate service times, never identities or reply text."""
import heapq
import argparse
import json
import math
from pathlib import Path
import random
from statistics import median

fixtures = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--slots", type=int, default=20)
slot_count = parser.parse_args().slots
if not 1 <= slot_count <= 100:
    parser.error("slots must be between 1 and 100")
profile = json.loads((fixtures / "peak-minute.json").read_text())
service = json.loads((fixtures / "service-time.json").read_text())
arrivals = []
original = 0
for second, (_, _, turns) in enumerate(profile):
    for turn in range(turns):
        segments = 3 if original % 7 < 2 else 2
        original += 1
        for copy in range(200):
            arrivals.append((1000 * (second + (turn + copy / 200) / turns), segments))

p50s, p95s = [], []
for seed in range(100):
    rng = random.Random(seed)
    slots = [0.0] * slot_count
    waits = []
    for offered, segments in arrivals:
        group = [row for row in service if row[0] == segments]
        first, last = rng.choices(group, weights=[row[2] for row in group])[0][3:]
        start = max(slots[0], offered)
        heapq.heapreplace(slots, start + last)
        waits.append(start + first - offered)
    waits.sort()
    p50s.append(waits[math.ceil(len(waits) * .50) - 1] / 3600000)
    p95s.append(waits[math.ceil(len(waits) * .95) - 1] / 3600000)

print(json.dumps({"slots": slot_count, "historicalTurns": sum(row[2] for row in service), "offered": len(arrivals),
                  "simulationRuns": len(p50s), "p50Hours": round(median(p50s), 2),
                  "p95Hours": round(median(p95s), 2),
                  "p95AcrossSeedsHours": [round(min(p95s), 2), round(max(p95s), 2)]}))
