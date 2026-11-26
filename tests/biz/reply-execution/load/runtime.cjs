// Run inside the network namespace of the disposable PostgreSQL container.
const { networkInterfaces } = require('node:os');
const { createRequire } = require('node:module');
const { setTimeout: sleep } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { Pool } = require('pg');

if (
  process.platform !== 'linux' ||
  Object.values(networkInterfaces())
    .flat()
    .some((iface) => !iface.internal)
) {
  throw new Error('The load fixture requires a loopback-only network namespace');
}
const app = createRequire('/bench/app/dist/main.js');
const { ActionRecordsRepository } = app('./biz/action-execution/action-records.repository');
const { ActionExecutorService } = app('./biz/action-execution/action-executor.service');
const { ReplyTurnsRepository } = app('./biz/reply-execution/reply-turns.repository');
const { ReplyTurnsService } = app('./biz/reply-execution/reply-turns.service');
const { DurableReplyDeliveryService } = app(
  './channels/wecom/message/delivery/durable-reply-delivery.service',
);
const { MessageDeliveryService } = app('./channels/wecom/message/delivery/delivery.service');
const { identifyAction, actionDigest } = app('./biz/action-execution/action-identity');
app('@nestjs/common').Logger.overrideLogger(false);
const db = new Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cake_projection_reply_load_1589',
  user: 'postgres',
  max: 3,
});
const bins = require('./peak-minute.json');
const clock = () => performance.now();
const rounded = (n) => Math.round(n * 10) / 10;
function stats(ms) {
  if (!ms.length) return { n: 0 };
  const v = [...ms].sort((a, b) => a - b);
  const p = (pct) => rounded(v[Math.max(0, Math.ceil(v.length * pct) - 1)]);
  return { n: v.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: p(1) };
}

function transport(extraRtt = 0) {
  const elapsed = [],
    errors = {},
    operations = {};
  async function send(name, args, signal = AbortSignal.timeout(5000)) {
    const begin = clock();
    const op = name + '.' + args.p_operation;
    operations[op] = (operations[op] || 0) + 1;
    try {
      if (extraRtt) await sleep(extraRtt / 2);
      const res = await fetch('http://127.0.0.1:3000/rpc/' + name, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal,
      });
      const result = await res.json();
      if (extraRtt) await sleep(extraRtt / 2);
      if (!res.ok) throw new Error(result.code || 'HTTP_' + res.status);
      return result;
    } catch (e) {
      errors[e.message] = (errors[e.message] || 0) + 1;
      throw e;
    } finally {
      elapsed.push(clock() - begin);
    }
  }
  const client = {
    rpc: (name, args) => ({
      abortSignal: async (signal) => {
        try {
          return { data: await send(name, args, signal), error: null };
        } catch (error) {
          return { data: null, error };
        }
      },
    }),
  };
  return {
    send,
    service: { getSupabaseClient: () => client },
    summary: () => ({ ms: stats(elapsed), operations, errors }),
  };
}

function fixtureServices(transport, sender, permit) {
  const config = {
    get: (key) => (key === 'ACTION_EXECUTION_MODE' ? 'execute' : '2026-01-01T00:00:00Z'),
  };
  const turns = new ReplyTurnsService(new ReplyTurnsRepository(transport.service), config);
  const executor = new ActionExecutorService(
    new ActionRecordsRepository(transport.service),
    config,
  );
  const durable = new DurableReplyDeliveryService(turns, executor, {}, permit, sender);
  const delivery = new MessageDeliveryService(
    sender,
    {},
    { calculateDelay: () => 0 },
    { markFirstSegmentSent: async () => {} },
    permit,
    durable,
  );
  return { turns, delivery };
}

async function sampleDb() {
  const {
    rows: [row],
  } = await db.query(`
    SELECT clock_timestamp() at, pg_read_file('/sys/fs/cgroup/cpu.stat',0,4096,true) cpu,
      pg_read_file('/sys/fs/cgroup/memory.current',0,128,true) mem,
      xact_commit+xact_rollback tx,deadlocks,
      (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend') clients,
      (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()) locks
    FROM pg_stat_database WHERE datname=current_database()`);
  return {
    at: +new Date(row.at),
    usec: Number(/usage_usec (\d+)/.exec(row.cpu || '')?.[1]),
    mem: Number(row.mem),
    tx: Number(row.tx),
    deadlocks: Number(row.deadlocks),
    clients: Number(row.clients),
    locks: Number(row.locks),
  };
}
function dbStats(samples) {
  const first = samples[0],
    last = samples.at(-1);
  const percentages = samples
    .slice(1)
    .map((s, i) => (s.usec - samples[i].usec) / (s.at - samples[i].at) / 20);
  return {
    cpuPctOfTwoCores: stats(percentages),
    peakMemMiB: rounded(Math.max(...samples.map((s) => s.mem)) / 1048576),
    deadlocks: last.deadlocks - first.deadlocks,
    maxClients: Math.max(...samples.map((s) => s.clients)),
    maxObservedLockWaiters: Math.max(...samples.map((s) => s.locks)),
    transactions: last.tx - first.tx,
  };
}
module.exports = {
  app,
  db,
  bins,
  clock,
  sleep,
  stats,
  rounded,
  transport,
  fixtureServices,
  identifyAction,
  actionDigest,
  sampleDb,
  dbStats,
};
