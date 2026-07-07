import { Injectable, Module, Logger, OnApplicationShutdown } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Redis as IORedisClient } from 'ioredis';

/**
 * Bull 用自定义 createClient 时，queue.close() 不会关闭我们创建的 ioredis 连接
 * （Bull 约定：谁创建谁负责关闭）。这里登记所有创建的连接，应用关停时统一优雅退出，
 * 避免滚动发版期间旧实例的 TCP 连接挂到进程死亡才被 OS 回收、推高 Upstash 连接数。
 */
const createdRedisClients: IORedisClient[] = [];

@Injectable()
export class BullRedisLifecycleService implements OnApplicationShutdown {
  private readonly logger = new Logger(BullRedisLifecycleService.name);

  /** OnApplicationShutdown 在所有 onModuleDestroy（含队列 drain）之后触发，此时关连接是安全的。 */
  async onApplicationShutdown(): Promise<void> {
    if (createdRedisClients.length === 0) return;
    this.logger.log(`[Shutdown] 关闭 ${createdRedisClients.length} 个 Bull Redis 连接...`);
    await Promise.allSettled(
      createdRedisClients.map(async (client) => {
        try {
          // quit 是优雅关闭（等待挂起命令）；3s 未完成则强制 disconnect。
          await Promise.race([
            client.quit(),
            new Promise((resolve) => setTimeout(resolve, 3000).unref()),
          ]);
        } catch {
          // quit 对已断开的连接会抛错，直接落到 disconnect
        } finally {
          client.disconnect();
        }
      }),
    );
    createdRedisClients.length = 0;
    this.logger.log('[Shutdown] ✅ Bull Redis 连接已关闭');
  }
}

function parseRedisUrl(redisUrl: string): {
  protocol: string;
  password: string;
  host: string;
  port: number;
} | null {
  const match = redisUrl.match(/^(rediss?):\/\/(?:([^:]+):)?([^@]+)@([^:]+):(\d+)$/);
  if (!match) return null;

  const [, protocol, , password, host, port] = match;
  return {
    protocol,
    password,
    host,
    port: parseInt(port, 10),
  };
}

/**
 * 获取 Bull 队列前缀，确保多环境共用同一个 Upstash Redis 时队列物理隔离。
 * 优先 RUNTIME_ENV，其次 NODE_ENV，缺省 development。
 */
function resolveBullPrefix(configService: ConfigService): string {
  const env = (
    configService.get<string>('RUNTIME_ENV') ||
    configService.get<string>('NODE_ENV') ||
    'development'
  ).trim();
  return `bull:${env}`;
}

function createBullQueueOptions(configService: ConfigService) {
  const logger = new Logger(BullQueueModule.name);
  const prefix = resolveBullPrefix(configService);
  logger.log(`Bull 队列前缀: ${prefix}`);
  let upstashTcpUrl = configService.get<string>('UPSTASH_REDIS_TCP_URL');

  if (upstashTcpUrl && !upstashTcpUrl.startsWith('redis')) {
    const cleanMatch = upstashTcpUrl.match(/(rediss?:\/\/[^"]+)/);
    if (cleanMatch) {
      logger.warn('检测到被污染的 Redis URL，已自动清理');
      upstashTcpUrl = cleanMatch[1];
    }
  }

  if (upstashTcpUrl) {
    const parsed = parseRedisUrl(upstashTcpUrl);
    if (parsed) {
      const { protocol, password, host, port } = parsed;
      logger.log(`使用 Upstash Redis 队列连接: ${host}:${port}`);

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Redis = require('ioredis');
      const baseRedisOpts = {
        host,
        port,
        password,
        tls: protocol === 'rediss' ? {} : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: (times: number) => Math.min(times * 100, 3000),
      };
      const sharedClient = new Redis(baseRedisOpts);
      const sharedSubscriber = new Redis(baseRedisOpts);
      createdRedisClients.push(sharedClient, sharedSubscriber);

      return {
        prefix,
        createClient: (type: 'client' | 'subscriber' | 'bclient') => {
          switch (type) {
            case 'client':
              return sharedClient;
            case 'subscriber':
              return sharedSubscriber;
            case 'bclient': {
              const bclient = new Redis(baseRedisOpts);
              createdRedisClients.push(bclient);
              return bclient;
            }
            default:
              throw new Error(`Unknown Redis connection type: ${type}`);
          }
        },
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
        settings: {
          stalledInterval: 30000,
          lockDuration: 60000,
          lockRenewTime: 15000,
          maxStalledCount: 2,
          // delayed job 激活轮询间隔，默认 5s → 压到 1s，降低单条消息排队抖动
          guardInterval: 1000,
        },
      };
    }

    logger.warn('Upstash Redis URL 格式无法解析，准备回退到其他配置');
  }

  const redisUrl = configService.get<string>('REDIS_URL');
  if (redisUrl) {
    const parsed = parseRedisUrl(redisUrl);
    if (parsed) {
      const { protocol, password, host, port } = parsed;
      logger.log(`使用通用 Redis 队列连接: ${host}:${port}`);
      return {
        prefix,
        redis: {
          host,
          port,
          password: password || undefined,
          tls: protocol === 'rediss' ? {} : undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 1000,
        },
      };
    }
  }

  logger.warn('未检测到远端 Redis 队列配置，回退到本地 Redis');
  return {
    prefix,
    redis: {
      host: configService.get<string>('REDIS_HOST', 'localhost'),
      port: parseInt(configService.get<string>('REDIS_PORT', '6379'), 10),
      password: configService.get<string>('REDIS_PASSWORD'),
      tls: configService.get<string>('REDIS_TLS', 'false') === 'true' ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  };
}

@Module({
  imports: [
    ConfigModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => createBullQueueOptions(configService),
      inject: [ConfigService],
    }),
  ],
  providers: [BullRedisLifecycleService],
  exports: [BullModule],
})
export class BullQueueModule {}
