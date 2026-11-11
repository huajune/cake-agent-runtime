// TS_NODE_TRANSPILE_ONLY=true node -r ts-node/register -r tsconfig-paths/register \
//   tests/channels/wecom/message/pending-inputs.redis.cjs cake-pending-ack-...
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { getQueueToken } = require('@nestjs/bull');
const {
  SimpleMergeService,
} = require('../../../../src/channels/wecom/message/runtime/simple-merge.service');
const { RedisService } = require('../../../../src/infra/redis/redis.service');
const { RedisLeaseService } = require('../../../../src/infra/queue/redis-lease.service');
const {
  MessageRuntimeConfigService,
} = require('../../../../src/channels/wecom/message/runtime/message-runtime-config.service');
const {
  WecomMessageObservabilityService,
} = require('../../../../src/channels/wecom/message/telemetry/wecom-message-observability.service');

const container = process.argv[2];
if (!container?.startsWith('cake-pending-ack-'))
  throw new Error('isolated Redis container required');
const info = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(info.HostConfig.NetworkMode, 'none');
assert.equal(Object.keys(info.HostConfig.PortBindings ?? {}).length, 0);
const redis = (...args) =>
  execFileSync('docker', ['exec', container, 'redis-cli', '--raw', ...args.map(String)], {
    encoding: 'utf8',
  }).trim();
const key = 'wecom:message:pending:identity-spec';
const message = (messageId) => ({
  messageId,
  chatId: 'identity-spec',
  payload: { text: 'fixture' },
});
const push = (...ids) => redis('RPUSH', key, ...ids.map((id) => JSON.stringify(message(id))));
const rows = () =>
  JSON.parse(redis('EVAL', "return cjson.encode(redis.call('LRANGE', KEYS[1], 0, -1))", 1, key));
const ids = () => rows().map((row) => JSON.parse(row).messageId);
let lostResponse = false;
let evalCount = 0;
const client = {
  lrange: async () => rows(),
  eval: async (script, keys, args) => {
    evalCount++;
    const reply = redis('EVAL', script, keys.length, ...keys, ...args);
    if (lostResponse) {
      lostResponse = false;
      push('arrived-during-ack-retry');
      throw new Error('simulated lost Redis response after successful execution');
    }
    return Number(reply);
  },
};

(async () => {
  const module = await Test.createTestingModule({
    providers: [
      SimpleMergeService,
      { provide: RedisService, useValue: client },
      { provide: RedisLeaseService, useValue: {} },
      { provide: MessageRuntimeConfigService, useValue: {} },
      { provide: WecomMessageObservabilityService, useValue: {} },
      { provide: getQueueToken('message-merge'), useValue: {} },
    ],
  }).compile();
  const service = module.get(SimpleMergeService);
  try {
    redis('DEL', key);
    push('old-input');
    const original = await service.claimPendingSnapshot('identity-spec');
    redis('PEXPIRE', key, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(redis('EXISTS', key), '0');
    push('new-after-expiry');
    await service.ackPendingMessageIds(
      'identity-spec',
      original.messages.map((item) => item.messageId),
    );
    assert.deepEqual(ids(), ['new-after-expiry']);
    assert.deepEqual(
      (await service.claimPendingSnapshot('identity-spec')).messages.map((item) => item.messageId),
      ['new-after-expiry'],
    );

    redis('DEL', key);
    push('old-input');
    lostResponse = true;
    evalCount = 0;
    await service.ackPendingMessageIds('identity-spec', ['old-input']);
    assert.equal(evalCount, 2);
    assert.deepEqual(ids(), ['arrived-during-ack-retry']);

    redis('DEL', key);
    push('first', 'second', 'first', 'later');
    await service.ackPendingMessageIds('identity-spec', ['second']);
    await service.ackPendingMessageIds('identity-spec', ['first', 'second', 'first']);
    await service.ackPendingMessageIds('identity-spec', ['first', 'second']);
    assert.deepEqual(ids(), ['later']);

    redis('DEL', key);
    const invalid = ['invalid-json', 'null', 'true', '42', '{}', '{"messageId":""}'];
    redis('RPUSH', key, ...invalid);
    push('processed', 'processed', 'newer');
    const parsed = await service.claimPendingSnapshot('identity-spec');
    assert.deepEqual(
      parsed.messages.map((item) => item.messageId),
      ['processed', 'newer'],
    );
    await service.ackPendingMessageIds('identity-spec', ['processed']);
    assert.deepEqual(rows(), [...invalid, JSON.stringify(message('newer'))]);
    console.log(
      'PASS: TTL recreation, full snapshot, lost ACK response, partial/reordered/repeated ACKs, malformed rows, duplicate IDs, preservation of new inputs.',
    );
  } finally {
    redis('DEL', key);
    await module.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
