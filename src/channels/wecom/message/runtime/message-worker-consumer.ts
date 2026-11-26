import Bull = require('bull');
import type { Job, Queue } from 'bull';
import { QUEUE_WORKER_SETTINGS } from '@infra/queue/queue-policy';

export type MessageJob = Job<{ chatId: string }>;

export interface MessageWorkerConsumer {
  ready(): Promise<unknown>;
  process(jobHandler: (job: MessageJob) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

// Bull 4 的 process() 会调用 setWorkerName() 却不等待它。每个消费者只登记一次，
// 把同一份 CLIENT SETNAME 回执纳入就绪检查，避免紧接着 close() 中断未观察的命令。
class MessageBullQueue extends Bull {
  private named?: Promise<void>;

  override setWorkerName(): Promise<void> {
    this.named ??= super.setWorkerName().then(() => undefined);
    return this.named;
  }
}

/** 一次注册共用队列名和前缀。close 只排空本组消费者，生产者继续接收入站任务。 */
export function createMessageWorkerConsumer(
  source: Queue,
  prefix: string,
  concurrency: number,
  listen: (consumer: Queue) => void,
): MessageWorkerConsumer {
  if (!source.client.options.host?.endsWith('.upstash.io')) {
    const worker = new MessageBullQueue(source.name, {
      prefix,
      redis: source.client.options,
      settings: QUEUE_WORKER_SETTINGS,
    });
    listen(worker);
    return {
      ready: () => worker.setWorkerName(),
      process: (handler) => worker.process('process', concurrency, handler),
      close: () => worker.close(),
    };
  }

  // Upstash 同一阻塞连接上并行 BRPOPLPUSH 会延迟返回并误报 stalled。
  // 各槽独占阻塞连接，普通命令和订阅在本组内共享。整组随本次注册一起释放。
  const options = { maxRetriesPerRequest: null, enableReadyCheck: false };
  const commands = source.client.duplicate(options);
  const subscriber = source.client.duplicate(options);
  const connections = [commands, subscriber];
  commands.setMaxListeners(concurrency + 10);
  subscriber.setMaxListeners(concurrency + 10);
  const workers = Array.from({ length: concurrency }, (_, index) => {
    const blocking = source.client.duplicate(options);
    connections.push(blocking);
    const worker = new MessageBullQueue(source.name, {
      prefix,
      // 第一个槽按队列策略检查延迟任务，其余槽降低空队列的定时轮询频率。
      settings:
        index === 0
          ? QUEUE_WORKER_SETTINGS
          : { ...QUEUE_WORKER_SETTINGS, guardInterval: 30_000, drainDelay: 30 },
      createClient: (type) => {
        if (type === 'client') return commands;
        if (type === 'subscriber') return subscriber;
        return blocking;
      },
    });
    listen(worker);
    return worker;
  });
  let closing: Promise<void> | undefined;
  return {
    ready: () =>
      Promise.all([subscriber.ping(), ...workers.map((worker) => worker.setWorkerName())]),
    process: async (handler) => {
      await Promise.all(workers.map((worker) => worker.process('process', 1, handler)));
    },
    close: () => {
      closing ??= Promise.allSettled(workers.map((worker) => worker.close())).then((results) => {
        for (const connection of connections) connection.disconnect();
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      });
      return closing;
    },
  };
}
