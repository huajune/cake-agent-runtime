import { ConfigService } from '@nestjs/config';
import { BullRedisLifecycleService, createBullQueueOptions } from '@infra/queue/bull.module';
import { QUEUE_JOB_DEFAULTS, QUEUE_WORKER_SETTINGS } from '@infra/queue/queue-policy';

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
  })),
);

describe('Bull connection policy', () => {
  afterEach(async () => {
    await new BullRedisLifecycleService().onApplicationShutdown();
  });

  it.each([
    { UPSTASH_REDIS_TCP_URL: 'rediss://default:test@redis.invalid:6379' },
    { REDIS_URL: 'redis://default:test@redis.invalid:6379' },
    { REDIS_HOST: 'localhost' },
  ])('keeps worker safety and retention identical for connection config %j', (values) => {
    const config = new ConfigService({ ...values, RUNTIME_ENV: 'test' });
    const result = createBullQueueOptions(config);
    expect(result.prefix).toBe('bull:test');
    expect(result.defaultJobOptions).toEqual(QUEUE_JOB_DEFAULTS);
    expect(result.settings).toEqual(QUEUE_WORKER_SETTINGS);
    expect(result.defaultJobOptions.removeOnFail).not.toBe(true);
    expect(result.settings.lockRenewTime).toBeLessThan(result.settings.lockDuration);
  });
});
