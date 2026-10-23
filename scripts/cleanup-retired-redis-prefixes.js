#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { parseEnv } = require('node:util');

// Compare canonical logical content: DUMP serialization is not stable across Redis replicas.
const READ_CONTENT = `local t=redis.call('TYPE',KEYS[1]).ok
if t=='none' then return false end
local d
if t=='string' then d=redis.call('GET',KEYS[1])
elseif t=='hash' then
  local fields=redis.call('HKEYS',KEYS[1]); table.sort(fields); d={}
  for _,field in ipairs(fields) do table.insert(d,field); table.insert(d,redis.call('HGET',KEYS[1],field)) end
elseif t=='list' then d=redis.call('LRANGE',KEYS[1],0,-1)
elseif t=='set' then d=redis.call('SMEMBERS',KEYS[1]); table.sort(d)
elseif t=='zset' then d=redis.call('ZRANGE',KEYS[1],0,-1,'WITHSCORES')
else return redis.error_reply('unsupported backup type') end
local digest=redis.sha1hex(cjson.encode({t,d}))
`;
const SNAPSHOT = READ_CONTENT + `return {t,redis.call('PTTL',KEYS[1]),digest,d}`;
const DELETE_UNCHANGED =
  READ_CONTENT + `if digest==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`;

async function main() {
  const args = process.argv.slice(2);
  const prefixes = args.flatMap((arg, i) => (arg === '--prefix' ? [args[i + 1]] : []));
  if (
    !prefixes.length ||
    prefixes.some(
      (p) => !/^(?:release-[\w-]+|shift-match-[\w-]+|codex-[\w-]+|local|bull:local)$/.test(p),
    )
  )
    throw new Error('Explicit retired test prefixes required; production forbidden');
  const option = (name, fallback) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const apply = args.includes('--apply');
  const backup = option('--backup', '');
  if (apply && !backup) throw new Error('--apply requires new private --backup path');
  const env = parseEnv(fs.readFileSync(option('--env', '.env.production'), 'utf8'));
  const url = env.UPSTASH_REDIS_REST_URL;
  if (new URL(url).protocol !== 'https:') throw new Error('HTTPS required');
  async function request(commands, pipeline = false) {
    const r = await fetch(url + (pipeline ? '/pipeline' : ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Redis HTTP ${r.status}`);
    const result = await r.json();
    const entries = pipeline ? result : [result];
    if (entries.some((entry) => entry.error)) throw new Error('Redis command failed');
    return pipeline ? entries.map((entry) => entry.result) : result.result;
  }
  const keys = new Set();
  let cursor = '0',
    rounds = 0;
  do {
    const page = await request(['SCAN', cursor, 'COUNT', 1000]);
    cursor = String(page[0]);
    page[1]
      .filter((key) => prefixes.some((prefix) => key.startsWith(prefix + ':')))
      .forEach((key) => keys.add(key));
    if (++rounds > 200 || keys.size > 5000) throw new Error('Scan/key cap exceeded');
  } while (cursor !== '0');
  const snapshots = [];
  const keyList = [...keys];
  for (let i = 0; i < keyList.length; i += 50) {
    const batch = keyList.slice(i, i + 50);
    const values = await request(
      batch.map((key) => ['EVAL', SNAPSHOT, 1, key]),
      true,
    );
    values.forEach((value, j) => {
      if (value)
        snapshots.push({
          key: batch[j],
          type: value[0],
          pttl: value[1],
          digest: value[2],
          data: value[3],
          capturedAt: new Date().toISOString(),
        });
    });
  }
  let deleted = 0;
  if (apply) {
    const fd = fs.openSync(backup, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ prefixes, snapshots }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let i = 0; i < snapshots.length; i += 50) {
      const results = await request(
        snapshots.slice(i, i + 50).map((s) => ['EVAL', DELETE_UNCHANGED, 1, s.key, s.digest]),
        true,
      );
      deleted += results.reduce((sum, count) => sum + count, 0);
    }
  }
  console.log(
    JSON.stringify({
      prefixes,
      found: keys.size,
      backedUp: snapshots.length,
      deleted,
      changedOrExpired: apply ? snapshots.length - deleted : 0,
    }),
  );
}
void main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
