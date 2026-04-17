import { Module, Logger } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';

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

function createBullQueueOptions(configService: ConfigService) {
  const logger = new Logger(BullQueueModule.name);
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

      return {
        createClient: (type: 'client' | 'subscriber' | 'bclient') => {
          switch (type) {
            case 'client':
              return sharedClient;
            case 'subscriber':
              return sharedSubscriber;
            case 'bclient':
              return new Redis(baseRedisOpts);
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
  exports: [BullModule],
})
export class BullQueueModule {}
