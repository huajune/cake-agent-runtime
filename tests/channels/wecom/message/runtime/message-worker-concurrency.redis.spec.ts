import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import Bull = require('bull');
import StandaloneConnector from 'ioredis/built/connectors/StandaloneConnector';
import type { RedisOptions } from 'ioredis';

import { ConfigService } from '@nestjs/config';
import { createMessageWorkerConsumer } from '@wecom/message/runtime/message-worker-consumer';
import { MessageWorkerManagerService } from '@wecom/message/runtime/message-worker-manager.service';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';
import { MessageOpsController } from '@wecom/message/ingress/message-ops.controller';
import { resolveBullPrefix } from '@infra/queue/bull.module';

// Exercise hosted connection layout against the same disposable loopback server.
class LoopbackConnector extends StandaloneConnector {
  constructor(options: RedisOptions) {
    super({ ...options, host: '127.0.0.1' });
  }
}

// 此回归只消费队列任务，不加载模型工具和简历 PDF 的原生依赖。
jest.mock('@wecom/message/application/pipeline.service', () => ({
  MessagePipelineService: class {},
}));

const redisPort = Number(process.env.ISOLATED_MESSAGE_WORKER_REDIS_PORT);
const isolated = redisPort ? describe : describe.skip;

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error('timed out waiting for the Bull queue');
    await sleep(20);
  }
}

isolated('message-merge concurrency with real Bull and loopback Redis', () => {
  it('awaits the blocking connection name before exposing slots and reuses its acknowledgement on immediate shutdown', async () => {
    const prefix = `name-ack-${randomUUID()}`;
    const source = new Bull('message-merge', {
      prefix,
      redis: { host: '127.0.0.1', port: redisPort },
    });
    const manager = new MessageWorkerManagerService({
      getSystemConfig: async () => ({ workerConcurrency: 50 }),
      getMessageMergeEnabled: async () => true,
    } as never);
    const original = Bull.prototype.setWorkerName;
    let acknowledge: () => void;
    const gate = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const naming = jest.spyOn(Bull.prototype, 'setWorkerName').mockImplementation(async function (
      this: Bull.Queue,
    ) {
      await gate;
      return original.call(this);
    });
    try {
      const starting = manager.initialize(
        (slots) => createMessageWorkerConsumer(source, prefix, slots, () => {}),
        async () => {},
      );
      await until(async () => naming.mock.calls.length > 0);
      expect(await manager.getStatus()).toMatchObject({
        concurrency: 50,
        registeredConcurrency: 0,
      });
      acknowledge();
      await starting;
      expect(await manager.getStatus()).toMatchObject({ registeredConcurrency: 50 });
      await manager.stop();
      expect(naming).toHaveBeenCalledTimes(1);
    } finally {
      acknowledge();
      await manager.stop();
      naming.mockRestore();
      await source.obliterate({ force: true });
      await source.close();
    }
  });

  it.each(['127.0.0.1', 'isolated.upstash.io'])(
    'uses %s layout for 20, 50, 100 and 2 actual slots, then reloads 50 on restart',
    async (host) => {
      const fixture = `test-worker-${randomUUID()}`;
      const env = new ConfigService({ RUNTIME_ENV: fixture });
      const queue = () =>
        new Bull('message-merge', {
          redis: { host, port: redisPort, connectionName: fixture, Connector: LoopbackConnector },
          prefix: resolveBullPrefix(env),
        });
      const commandStates = new Set<string>();
      const nameWorker = Bull.prototype.setWorkerName;
      const naming = jest.spyOn(Bull.prototype, 'setWorkerName').mockImplementation(function (
        this: Bull.Queue,
      ) {
        commandStates.add(this.client.status);
        return nameWorker.call(this);
      });
      const producer = queue();
      const runningJobs = new Map<string, () => void>();
      const started: string[] = [];
      let freeRun = false;
      let saved = 20;
      const config = {
        getSystemConfig: async () => ({ workerConcurrency: saved }),
        updateSystemConfig: async ({ workerConcurrency }: { workerConcurrency: number }) => {
          saved = workerConcurrency;
        },
        getMessageMergeEnabled: async () => true,
      };
      const merge = {
        acquireProcessingLock: async (chatId: string) => {
          started.push(chatId);
          if (!freeRun) await new Promise<void>((resolve) => runningJobs.set(chatId, resolve));
          return false;
        },
        scheduleLockRetryCheck: async () => undefined,
      };
      const newProcessor = () =>
        new MessageProcessor(
          queue(),
          undefined,
          merge as never,
          new MessageWorkerManagerService(config as never),
          undefined,
          undefined,
          undefined,
          env,
          undefined,
          undefined,
          undefined,
        );
      let processor = newProcessor();
      let api = new MessageOpsController(processor);
      const releaseJobs = () => {
        for (const release of runningJobs.values()) release();
        runningJobs.clear();
      };
      const openConnections = async () => {
        const clients = String(await producer.client.client('LIST'));
        return clients.split('\n').filter((line) => line.includes(fixture)).length;
      };
      const checkpoint = async (slots: number, waiting: number) => {
        await until(
          async () => runningJobs.size === slots && (await producer.getWaitingCount()) === waiting,
        );
        expect(await producer.getActiveCount()).toBe(slots);
        if (host.endsWith('.upstash.io')) {
          // N 阻塞 + 2 共享连接，另外两条分别来自本测试的投递端和 Nest 注入的队列。
          expect(await openConnections()).toBe(slots + 4);
        }
        expect(await api.getWorkerStatus()).toMatchObject({
          concurrency: slots,
          registeredConcurrency: slots,
          activeJobs: slots,
        });
      };
      const resize = async (value: number) => {
        expect(await api.setWorkerConcurrency({ concurrency: value })).toMatchObject({
          success: true,
          currentConcurrency: value,
          registeredConcurrency: 0,
        });
        expect(saved).toBe(value);
      };
      try {
        await processor.onModuleInit();
        await producer.addBulk(
          Array.from({ length: 280 }, (_, n) => ({ name: 'process', data: { chatId: String(n) } })),
        );
        await checkpoint(20, 260);
        await resize(50);
        await producer.add('process', { chatId: 'during-drain' });
        expect(await producer.isPaused()).toBe(false);
        expect(await producer.getWaitingCount()).toBe(261);
        releaseJobs();
        await checkpoint(50, 211);
        await resize(100);
        releaseJobs();
        await checkpoint(100, 111);
        expect(await api.setWorkerConcurrency({ concurrency: 101 })).toMatchObject({
          success: false,
          registeredConcurrency: 100,
        });
        await resize(2);
        releaseJobs();
        await checkpoint(2, 109);
        freeRun = true;
        releaseJobs();
        await until(async () => (await producer.getCompletedCount()) === 281);
        await producer.add('process', { chatId: 'after-idle' }, { delay: 50 });
        await until(async () => (await producer.getCompletedCount()) === 282);
        expect(started).toHaveLength(282);
        expect(new Set(started).size).toBe(282);
        expect(await producer.getFailedCount()).toBe(0);
        await resize(50);
        await until(async () => (await api.getWorkerStatus()).registeredConcurrency === 50);
        await processor.onModuleDestroy();
        await until(async () => (await openConnections()) === 1);
        processor = newProcessor();
        api = new MessageOpsController(processor);
        await processor.onModuleInit();
        expect(await api.getWorkerStatus()).toMatchObject({
          concurrency: 50,
          registeredConcurrency: 50,
          activeJobs: 0,
        });
        if (host.endsWith('.upstash.io')) expect([...commandStates]).toEqual(['ready']);
      } finally {
        naming.mockRestore();
        freeRun = true;
        releaseJobs();
        await processor.onModuleDestroy();
        // The UUID prefix is unique to this test run.
        await producer.obliterate({ force: true });
        await producer.close();
      }
    },
    60_000,
  );
});
