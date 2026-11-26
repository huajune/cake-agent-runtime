const { createServer } = require('node:http');
const {
  app,
  db,
  bins,
  clock,
  sleep,
  stats,
  rounded,
  transport,
  fixtureServices,
  sampleDb,
  dbStats,
} = require('./runtime.cjs');
const Bull = app('bull'),
  Redis = app('ioredis');
const smoke = process.argv[2] === 'smoke';
const fromTurnStarts = process.argv[2] === 'starts';
const repeat = 200,
  concurrency = 20,
  corp = 'benchq-' + Date.now();
const rpc = transport(91),
  redis = new Redis({ host: '127.0.0.1', port: 6379 });
const queue = new Bull(corp, { redis: { host: '127.0.0.1', port: 6379 } });
const first = [],
  afterStart = [],
  waits = [],
  totals = [],
  dispatchIds = new Set(),
  live = new Map(),
  injection = [];
const errors = [],
  samples = [];
let finished = 0,
  failed = 0,
  peakWaiting = 0,
  atMinute,
  accepted = 0,
  lastComplete = 0;
const gateway = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const b = JSON.parse(Buffer.concat(chunks));
  await sleep(35);
  if (dispatchIds.has(b.externalRequestId)) {
    res.writeHead(409).end();
    return;
  }
  dispatchIds.add(b.externalRequestId);
  const row = live.get(b.chatId);
  if (!row.first) {
    row.first = clock();
    first.push(row.first - row.offered);
    afterStart.push(row.first - row.started);
  }
  accepted++;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"errcode":0}');
});
const sender = {
  sendMessage: async (p) => {
    const res = await fetch('http://127.0.0.1:7389/wecom', {
      method: 'POST',
      body: JSON.stringify(p),
    });
    if (!res.ok) throw Error('duplicate simulated send');
    return res.json();
  },
};
const permit = { evaluate: async () => ({ allowed: !(await redis.get(corp + ':paused')) }) };
const { turns, delivery } = fixtureServices(rpc, sender, permit);
async function work(job) {
  const { id, segments, offered } = job.data,
    chatId = 'chat-' + id,
    scope = { corpId: corp, accountId: 'bot', chatId };
  const started = clock(),
    lock = corp + ':' + chatId;
  waits.push(started - offered);
  live.set(chatId, { started, offered });
  if (!(await redis.set(lock, id, 'EX', 180, 'NX'))) throw Error('duplicate worker');
  const assertOwned = async () => {
    if ((await redis.get(lock)) !== String(id)) throw Error('lost lease');
  };
  try {
    const primary = { orgId: corp, imBotId: 'bot', chatId, imContactId: chatId };
    const original = await turns.open(scope, ['input-' + id], new Date().toISOString(), {
      primary,
    });
    const text = Array.from({ length: segments }, (_, i) => '合成回复 ' + (i + 1));
    const turn = await turns.saveEffects(
      original,
      { context: { ...scope, logicalTurnId: original.logicalTurnId }, toolCalls: [] },
      text,
    );
    let settled;
    const result = await delivery.deliverReply(
      { content: text.join('\n\n') },
      {
        ...primary,
        contactName: 'fixture',
        messageId: String(id),
        token: 'local',
        replyTurn: turn,
        assertOwned,
        onSettled: (t) => {
          settled = t;
        },
      },
      false,
    );
    if (result.deliveredSegments !== segments || !settled)
      throw Error('missing receipt or turn settlement');
    await turns.completeProjection(settled);
    await turns.acked(settled);
    totals.push(clock() - offered);
    finished++;
    lastComplete = clock();
  } finally {
    live.delete(chatId);
    await redis.del(lock);
  }
}
function arrivals() {
  if (smoke) return [{ id: 1, ms: 0, segments: 2 }];
  const jobs = [];
  if (fromTurnStarts) {
    for (const [second, segments] of require('./peak-turn-starts.json')) {
      for (let i = 0; i < repeat; i++)
        jobs.push({ id: jobs.length + 1, ms: second * 1000, segments });
    }
    return jobs;
  }
  let original = 0;
  for (let sec = 0; sec < bins.length; sec++) {
    const closing = bins[sec][2];
    for (let i = 0; i < closing; i++, original++) {
      const segments = original % 7 < 2 ? 3 : 2; // 6 three-part and 15 two-part turns per peak minute.
      for (let j = 0; j < repeat; j++)
        jobs.push({
          id: jobs.length + 1,
          segments,
          ms: sec * 1000 + ((i + j / repeat) * 1000) / closing,
        });
    }
  }
  return jobs;
}
async function run() {
  await new Promise((resolve) => gateway.listen(7389, '127.0.0.1', resolve));
  await queue.isReady();
  queue.on('failed', (_job, error) => {
    failed++;
    if (errors.length < 5) errors.push(error.message);
    lastComplete = clock();
  });
  queue.process(concurrency, work);
  const jobs = arrivals();
  const start = clock() + 200;
  let next = 0,
    lastSample = -2000,
    lastReport = -1;
  while (finished + failed < jobs.length) {
    const elapsed = clock() - start;
    if (elapsed > 900000) throw Error('queue test exceeded 15 minutes');
    const due = [];
    while (next < jobs.length && jobs[next].ms <= elapsed) {
      const j = jobs[next++];
      const offered = clock();
      injection.push(offered - (start + j.ms));
      due.push({
        name: '__default__',
        data: { ...j, offered },
        opts: { jobId: String(j.id), removeOnComplete: true },
      });
    }
    if (due.length) await queue.addBulk(due);
    if (elapsed - lastSample >= 500) {
      lastSample = elapsed;
      const [waiting, active, sample] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        sampleDb(),
      ]);
      peakWaiting = Math.max(peakWaiting, waiting);
      samples.push(sample);
      if (!atMinute && elapsed >= 60000)
        atMinute = {
          elapsedMs: rounded(elapsed),
          waiting,
          active,
          finished,
          firstAccepted: first.length,
        };
      const interval = Math.floor(elapsed / 30000);
      if (!smoke && interval > lastReport) {
        lastReport = interval;
        process.stderr.write(
          JSON.stringify({
            seconds: rounded(elapsed / 1000),
            offered: next,
            waiting,
            active,
            finished,
            failed,
          }) + '\n',
        );
      }
    }
    await sleep(next === jobs.length ? 100 : 5);
  }
  samples.push(await sampleDb());
  const {
    rows: [audit],
  } = await db.query(
    `SELECT
    (SELECT count(*) FROM agent_reply_turns WHERE corp_id=$1 AND status='acked')::int acked,
    (SELECT count(*) FROM agent_action_records WHERE corp_id=$1 AND status='succeeded' AND local_sync='complete')::int actions,
    (SELECT count(*) FROM agent_action_evidence WHERE corp_id=$1)::int receipts`,
    [corp],
  );
  const expected = jobs.reduce((n, j) => n + j.segments, 0);
  console.log(
    JSON.stringify({
      phase: 'queue',
      turns: jobs.length,
      expected,
      firstFromEnqueueMs: stats(first),
      waitForWorkerMs: stats(waits),
      firstFromWorkerMs: stats(afterStart),
      endToEndMs: stats(totals),
      peakWaiting,
      atMinute,
      injectionDelayMs: stats(injection),
      drainAfterMinuteSec: rounded(Math.max(0, lastComplete - start - 60000) / 1000),
      elapsedSec: rounded((lastComplete - start) / 1000),
      finished,
      failed,
      errors,
      accepted,
      audit,
      db: dbStats(samples),
      rpc: rpc.summary(),
    }),
  );
  if (
    failed ||
    audit.acked !== jobs.length ||
    accepted !== expected ||
    audit.actions !== expected ||
    audit.receipts !== expected
  )
    process.exitCode = 1;
}
run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await queue.close();
    await redis.quit();
    await db.end();
    gateway.close();
  });
