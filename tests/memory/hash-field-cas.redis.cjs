// Run only against an isolated no-network Redis container:
// TS_NODE_TRANSPILE_ONLY=true node -r ts-node/register tests/memory/hash-field-cas.redis.cjs cake-runtime-redis-cas-...
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { READ_HASH_FIELD_SNAPSHOT_SCRIPT: read, COMPARE_HASH_FIELD_SCRIPT: cas } =
  require('../../src/memory/stores/hash-field-cas.ts');
const container = process.argv[2];
if (!container?.startsWith('cake-runtime-redis-cas-')) throw new Error('isolated Redis container required');
const redis = (...args) => execFileSync('docker', ['exec', container, 'redis-cli', '--raw', ...args.map(String)], { encoding: 'utf8' }).trim();
const key = 'cas-spec:session';
const snapshot = () => JSON.parse(redis('EVAL', read, 1, key, 'facts', 'read-generation'));
const write = (value, expected, requireExisting = true) => Number(redis('EVAL', cas, 2, key, 'cas-spec:stage', 'facts', expected.raw === null ? 0 : 1, expected.raw ?? '', expected.generation ?? '', JSON.stringify(value), 90, requireExisting ? 0 : 1, 'new-generation'));
(async () => {
  redis('DEL', key, 'cas-spec:stage');
  const raw = '{ "name": "original" }';
  redis('HSET', key, 'facts', raw, 'unrelated', 'retained');
  redis('SET', 'cas-spec:stage', 'stage');
  const first = snapshot();
  assert.equal(first.raw, raw);
  assert.equal(write({ name: 'newer' }, first), 1);
  assert.equal(write({ name: 'late old writer' }, first), 0);
  assert.equal(redis('HGET', key, 'facts'), '{"name":"newer"}');
  assert.equal(redis('HGET', key, 'unrelated'), 'retained');
  assert(Number(redis('TTL', 'cas-spec:stage')) > 0);
  const beforeExpiry = snapshot();
  redis('PEXPIRE', key, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(write({ name: 'expired' }, beforeExpiry), 0);
  assert.equal(redis('EXISTS', key), '0');
  // A recreated hash with an absent field is a different generation (ABA protection).
  redis('HSET', key, 'unrelated', 'recreated');
  assert.equal(write({ name: 'expired generation' }, beforeExpiry), 0);
  const emptyField = snapshot();
  assert.equal(emptyField.raw, null);
  redis('DEL', key);
  redis('HSET', key, 'unrelated', 'another recreation');
  assert.equal(write({ name: 'missing-field ABA' }, emptyField), 0);
  redis('DEL', key, 'cas-spec:stage');
  const missing = snapshot();
  assert.equal(write({ name: 'old recovery' }, missing), 0);
  assert.equal(redis('EXISTS', key), '0');
  assert.equal(write({ name: 'live initial write' }, missing, false), 1);
  assert.equal(redis('EXISTS', 'cas-spec:stage'), '0');
  redis('DEL', key);
  console.log('PASS: raw bytes, competing writer, TTL expiry, recreation ABA, background no-revival, live initialization, stage TTL.');
})().catch(error => { console.error(error); process.exitCode = 1; });
