/** Raw bytes and a hash generation prevent read/merge/write races and expiry/recreate ABA. */
export interface HashFieldSnapshot {
  raw: string | null;
  generation: string | null;
  value: unknown;
}

export const READ_HASH_FIELD_SNAPSHOT_SCRIPT = `
  if redis.call('exists', KEYS[1]) == 0 then
    return cjson.encode({generation=cjson.null, raw=cjson.null})
  end
  redis.call('hsetnx', KEYS[1], '_projection_generation', ARGV[2])
  return cjson.encode({
    generation=redis.call('hget', KEYS[1], '_projection_generation'),
    raw=redis.call('hget', KEYS[1], ARGV[1]) or cjson.null
  })
`;

export const COMPARE_HASH_FIELD_SCRIPT = `
  local present = redis.call('exists', KEYS[1])
  if ARGV[4] == '' then
    if present ~= 0 or ARGV[7] ~= '1' then return 0 end
  elseif present == 0 or redis.call('hget', KEYS[1], '_projection_generation') ~= ARGV[4] then
    return 0
  end
  local current = redis.call('hget', KEYS[1], ARGV[1])
  if ARGV[2] == '0' then
    if current then return 0 end
  elseif current ~= ARGV[3] then return 0 end
  redis.call('hsetnx', KEYS[1], '_projection_generation', ARGV[8])
  redis.call('hset', KEYS[1], ARGV[1], ARGV[5])
  if tonumber(ARGV[6]) > 0 then
    for _, key in ipairs(KEYS) do redis.call('expire', key, ARGV[6]) end
  end
  return 1
`;
