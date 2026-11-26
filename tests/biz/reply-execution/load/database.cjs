// Fixed one-minute, open-loop replay of successful segment registrations, receipts and turn closes.
const {
  db,
  bins,
  clock,
  sleep,
  stats,
  rounded,
  transport,
  identifyAction,
  actionDigest,
  sampleDb,
  dbStats,
} = require('./runtime.cjs');
const smoke = process.argv[2] === 'smoke';
const minutes = process.argv[2] === 'repeat' ? 3 : 1;
const profile = smoke
  ? [
      [2, 0, 0],
      [0, 2, 1],
    ]
  : Array.from({ length: minutes }, () => bins).flat();
const factor = smoke ? 1 : 200,
  corp = 'benchdb-' + Date.now(),
  stamp = new Date().toISOString();
const rpc = transport(),
  segments = [],
  closes = [],
  injection = [],
  sojourn = [],
  samples = [],
  errors = [];
const completion = {
  status: 'succeeded',
  result: { stage: 'accepted' },
  evidence: {
    kind: 'accepted',
    requestTerminated: true,
    detail: 'send_api_accepted; not_delivery_or_read_receipt',
  },
};
const hash = actionDigest(completion);
function turn(i, kind) {
  return {
    corpId: corp,
    logicalTurnId: kind + i,
    accountId: 'bot',
    chatId: kind + i,
    owner: 'live',
    fence: 1,
  };
}
async function prepare() {
  const n = profile.reduce((sum, b) => sum + b[2] * factor, 0);
  // Use independent close rows because a minute contains replies that began outside the window.
  await db.query(
    `INSERT INTO agent_reply_turns(corp_id,logical_turn_id,account_id,chat_id,input_ids,
    input_occurred_at,mode,status,owner,fence,generation_until,recovery,projection_status)
    SELECT $1,k||i,'bot',k||i,ARRAY[k||i],now(),'execute','planned','live',1,now()+interval '10 minutes',
    jsonb_build_object('primary','{}'::jsonb,'traceId',$1||':'||k||i,'replySegments',case when i%7<2 then '["段0","段1","段2"]'::jsonb else '["段0","段1"]'::jsonb end),'pending'
    FROM generate_series(0,$2::int-1) i CROSS JOIN unnest(ARRAY['send','close']) k`,
    [corp, n],
  );
  await db.query(
    `WITH m AS (
    INSERT INTO message_processing_records(message_id,chat_id,bot_im_id,received_at,status)
    SELECT recovery->>'traceId',chat_id,account_id,input_occurred_at,'processing'
    FROM agent_reply_turns WHERE corp_id=$1 AND logical_turn_id LIKE 'close%'
    RETURNING message_id)
    INSERT INTO message_processing_turn_snapshots(message_id,response)
    SELECT message_id,'{"status":"processing"}' FROM m`,
    [corp],
  );
  const count = profile.reduce((sum, b) => sum + b[0] * factor, 0);
  for (let i = 0; i < n; i++) {
    const t = turn(i, 'send');
    closes.push(turn(i, 'close'));
    for (let j = 0; j < (i % 7 < 2 ? 3 : 2) && segments.length < count; j++) {
      const intent = {
        ...t,
        intentId: t.logicalTurnId + ':reply:v1:' + j,
        kind: 'wecom.reply_segment',
        target: 'chat:' + t.chatId + ':reply:' + t.logicalTurnId + ':segment:' + j,
        parameters: { text: '段' + j, index: j, version: 1 },
        occurredAt: stamp,
        identityReliable: true,
        recovery: { logicalTurnId: t.logicalTurnId, index: j },
      };
      delete intent.owner;
      delete intent.fence;
      const identity = identifyAction(intent);
      const owner = 'attempt-' + segments.length;
      const input = {
        ...identity,
        corpId: corp,
        intent,
        owner,
        mode: 'execute',
        resourceHash: actionDigest([corp, intent.target]),
        recoveryDeadline: new Date(Date.parse(stamp) + 86400000).toISOString(),
      };
      segments.push({ input, t, grant: Promise.withResolvers() });
    }
  }
  if (segments.length !== count) throw Error('fixture count mismatch');
}
function schedule() {
  const tasks = [];
  const ordinal = [0, 0, 0];
  for (let s = 0; s < profile.length; s++)
    for (let k = 0; k < 3; k++) {
      const count = profile[s][k] * factor;
      for (let j = 0; j < count; j++)
        tasks.push({ ms: s * 1000 + (j * 1000) / count, k, i: ordinal[k]++ });
    }
  return tasks.sort((a, b) => a.ms - b.ms || a.k - b.k);
}
async function runTask(task) {
  const { k, i } = task;
  if (k === 2) {
    const t = closes[i];
    const r = await rpc.send('transition_agent_reply_turn', {
      p_operation: 'settle',
      p_input: { ...t, deliveryResult: { outcome: 'complete', accepted: 2, total: 2 } },
    });
    if (r.turn?.status !== 'settled') throw Error(r.conflict || 'turn not settled');
    return;
  }
  const { input, t, grant } = segments[i];
  if (k === 0) {
    try {
      const r = await rpc.send('transition_agent_reply_segment', {
        p_operation: 'claim',
        p_input: input,
        p_turn: t,
      });
      if (!r.dispatchUntil || r.record?.dispatch_attempt_id !== input.owner)
        throw Error(r.conflict || 'no grant');
      grant.resolve(r.record);
    } catch (e) {
      grant.resolve(null);
      throw e;
    }
  } else {
    const record = await grant.promise;
    if (!record) throw Error('claim failed');
    const r = await rpc.send('transition_agent_action', {
      p_operation: 'settle',
      p_input: {
        corpId: corp,
        actionId: input.actionId,
        owner: input.owner,
        dispatchAttemptId: input.owner,
        fence: record.fence,
        completion,
        evidenceHash: hash,
      },
    });
    if (r.record?.status !== 'succeeded' || r.record?.local_sync !== 'complete')
      throw Error(r.conflict || 'receipt not settled');
  }
}
async function main() {
  await prepare();
  const tasks = schedule();
  samples.push(await sampleDb());
  const start = clock() + 200;
  let next = 0,
    completed = 0,
    failed = 0,
    maxOutstanding = 0,
    lastSample = 0,
    atEnd;
  const completedPerSecond = [];
  while (completed < tasks.length) {
    const elapsed = clock() - start;
    while (next < tasks.length && tasks[next].ms <= elapsed) {
      const task = tasks[next++];
      injection.push(clock() - start - task.ms);
      runTask(task)
        .catch((e) => {
          failed++;
          if (errors.length < 8) errors.push(e.message);
        })
        .finally(() => {
          const t = clock() - start;
          sojourn.push(t - task.ms);
          completed++;
          const sec = Math.floor(t / 1000);
          completedPerSecond[sec] = (completedPerSecond[sec] || 0) + 1;
        });
    }
    if (elapsed >= profile.length * 1000 && !atEnd)
      atEnd = { offered: next, completed, outstanding: next - completed };
    maxOutstanding = Math.max(maxOutstanding, next - completed);
    if (elapsed - lastSample >= 1000) {
      samples.push(await sampleDb());
      lastSample = elapsed;
    }
    if (elapsed > profile.length * 1000 + 90000) throw Error('open-loop replay did not drain');
    await sleep(3);
  }
  const elapsed = clock() - start;
  samples.push(await sampleDb());
  const {
    rows: [audit],
  } = await db.query(
    `SELECT
    (select count(*) from agent_action_records where corp_id=$1 and status='succeeded' and local_sync='complete')::int actions,
    (select count(*) from agent_action_evidence where corp_id=$1)::int receipts,
    (select count(*) from agent_reply_turns where corp_id=$1 and status='settled')::int turns`,
    [corp],
  );
  console.log(
    JSON.stringify({
      phase: 'database',
      scheduled: tasks.length,
      completed,
      failed,
      errors,
      elapsedSec: rounded(elapsed / 1000),
      peakOfferedPerSec: Math.max(...profile.map((b) => factor * b.reduce((a, v) => a + v, 0))),
      peakCompletedPerSec: Math.max(...completedPerSecond.filter(Number.isFinite)),
      atEnd: atEnd ?? { offered: next, completed, outstanding: 0 },
      maxOutstanding,
      injectionDelayMs: stats(injection),
      offerToCompletionMs: stats(sojourn),
      rpc: rpc.summary(),
      audit,
      db: dbStats(samples),
    }),
  );
  if (
    failed ||
    audit.receipts !== segments.length ||
    audit.actions !== segments.length ||
    audit.turns !== closes.length
  )
    process.exitCode = 1;
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.end());
