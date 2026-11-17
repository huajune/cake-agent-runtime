import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Test, type TestingModule } from '@nestjs/testing';
import { TouchLedgerService } from '@agent/reengagement/touch-ledger.service';
import { RedisService } from '@infra/redis/redis.service';

jest.setTimeout(30_000);

/** 显式启用时用隔离随机前缀验证真实 Lua；不访问任何运行时 key，结束只删本测试创建的 key。 */
const run = process.env.RUN_REENGAGEMENT_REDIS_TEST === '1' ? describe : describe.skip;
run('托管恢复触达槽 Redis 原子性', () => {
  let client: Redis;
  let module: TestingModule;
  let ledger: TouchLedgerService;
  const prefix = `test:reengagement-hosting-recovery:${randomUUID()}:`;
  const keys = new Set<string>();
  const scoped = (key: string): string => {
    const full = prefix + key;
    keys.add(full);
    return full;
  };

  beforeAll(async () => {
    const url = process.env.UPSTASH_REDIS_TCP_URL ?? process.env.REDIS_URL;
    if (!url) throw new Error('Isolated Redis test requires a configured Redis URL');
    client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 10_000,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    await client.connect();
    module = await Test.createTestingModule({
      providers: [
        TouchLedgerService,
        {
          provide: RedisService,
          useValue: {
            setNx: async (key: string, value: string, ttl: number) =>
              (await client.set(scoped(key), value, 'EX', ttl, 'NX')) === 'OK',
            get: (key: string) => client.get(scoped(key)),
            setex: (key: string, ttl: number, value: string) =>
              client.setex(scoped(key), ttl, value),
            eval: (script: string, inputKeys: string[], args: Array<string | number>) =>
              client.eval(script, inputKeys.length, ...inputKeys.map(scoped), ...args),
            lrange: (key: string, start: number, end: number) =>
              client.lrange(scoped(key), start, end),
          },
        },
      ],
    }).compile();
    ledger = module.get(TouchLedgerService);
  }, 15_000);

  afterAll(async () => {
    if (client?.status === 'ready' && keys.size) await client.del(...keys);
    client?.disconnect();
    await module?.close();
  });

  it('同一恢复轮次并发抢占仅一个成功，旧 job 补排不能释放正在发送的槽', async () => {
    await ledger.reserve('race');
    await ledger.markDeliveryAttempted('race');
    expect(await ledger.markWaitingForHosting('race', 1)).toBe(false);
    expect(await ledger.markWaitingForHosting('race', 1, true)).toBe(true);
    const results = await Promise.all(Array.from({ length: 8 }, () => ledger.reserve('race', 1)));
    expect(results.filter((result) => result === 'reserved')).toHaveLength(1);
    await ledger.markDeliveryAttempted('race');
    await ledger.markWaitingForHosting('race', 1);
    expect(await ledger.markWaitingForHosting('race', 2)).toBe(false);
    expect(await ledger.getState('race')).toBe('delivery_attempted');
    expect(await ledger.reserve('race', 1)).toBe('duplicate_inflight');
  });

  it('再掉线可进入新轮次，旧轮次不能接管；成功触达只计一次', async () => {
    await ledger.markWaitingForHosting('rounds', 1);
    await ledger.reserve('rounds', 1);
    await ledger.markDeliveryAttempted('rounds');
    await ledger.markWaitingForHosting('rounds', 2, true);
    expect(await ledger.reserve('rounds', 1)).toBe('duplicate_inflight');
    expect(await ledger.reserve('rounds', 2)).toBe('reserved');
    await ledger.markSent('rounds', 'session', Date.now());
    await ledger.markSent('rounds', 'session', Date.now());
    await ledger.markWaitingForHosting('rounds', 2);
    expect(await ledger.getState('rounds')).toBe('sent');
    expect(await ledger.markWaitingForHosting('rounds', 3)).toBe(false);
    expect(await ledger.reserve('rounds', 2)).toBe('duplicate_sent');
    expect(await ledger.countSentIn24h('session', Date.now())).toBe(1);
  });

  it('未知结果及过期丢失槽不会被恢复任务变成可重发', async () => {
    await ledger.markWaitingForHosting('unknown', 1);
    await ledger.reserve('unknown', 1);
    await ledger.markFailedOrUnknown('unknown', 'unknown');
    expect(await ledger.markWaitingForHosting('unknown', 2)).toBe(false);
    expect(await ledger.reserve('unknown', 1)).toBe('duplicate_inflight');
    expect(await ledger.reserve('missing', 1)).toBe('duplicate_inflight');
  });

  it('取消等待任务后旧 job 不能补排复活，取消旧轮次也不会影响新轮次', async () => {
    await ledger.markWaitingForHosting('cancelled', 1);
    await ledger.cancelWaitingForHosting('cancelled', 1);
    expect(await ledger.markWaitingForHosting('cancelled', 1)).toBe(false);
    expect(await ledger.markWaitingForHosting('cancelled', 2)).toBe(false);
    expect(await ledger.reserve('cancelled', 1)).toBe('duplicate_inflight');

    await ledger.markWaitingForHosting('newer-round', 2);
    await ledger.cancelWaitingForHosting('newer-round', 1);
    expect(await ledger.reserve('newer-round', 2)).toBe('reserved');
  });
});
