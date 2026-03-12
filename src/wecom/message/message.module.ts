import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { MessageProcessor } from './message.processor';
import { AgentModule } from '@agent';
import { MessageSenderModule } from '../message-sender/message-sender.module';

// 导入子服务
import { MessageDeduplicationService } from './services/message-deduplication.service';
import { MessageHistoryService } from './services/message-history.service';
import { MessageFilterService } from './services/message-filter.service';
import { SimpleMergeService } from './services/simple-merge.service';
import { MessageStatisticsService } from './services/message-statistics.service';
import { TypingDelayService } from './services/message-typing-delay.service';
import { MessageDeliveryService } from './services/message-delivery.service';
import { AgentGatewayService } from './services/message-agent-gateway.service';
import { MessageCallbackAdapterService } from './services/message-callback-adapter.service';
import { MessagePipelineService } from './services/message-pipeline.service';
import { BookingDetectionService } from './services/booking-detection.service';
import { BizModule } from '@biz/biz.module';
import { FeishuModule } from '@core/feishu';

/**
 * 消息处理模块
 * 负责接收、解析消息并触发 AI 自动回复
 */
@Module({
  imports: [
    ConfigModule,
    AgentModule,
    MessageSenderModule,
    BizModule,
    FeishuModule,
    // 配置 Bull 队列根模块
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        // 优先使用 Upstash TCP 连接
        let upstashTcpUrl = configService.get<string>('UPSTASH_REDIS_TCP_URL');

        // 自动清理被污染的环境变量（如 REDIS_URL="rediss://..." 格式）
        if (upstashTcpUrl && !upstashTcpUrl.startsWith('redis')) {
          const cleanMatch = upstashTcpUrl.match(/(rediss?:\/\/[^"]+)/);
          if (cleanMatch) {
            console.log('[BullModule] 检测到被污染的 URL，已自动清理');
            upstashTcpUrl = cleanMatch[1];
          }
        }

        if (upstashTcpUrl) {
          // 解析 Upstash URL: rediss://default:password@host:port
          // 使用正则解析，因为 new URL() 不支持 rediss: 协议
          const match = upstashTcpUrl.match(/^(rediss?):\/\/(?:([^:]+):)?([^@]+)@([^:]+):(\d+)$/);
          if (match) {
            const [, protocol, , password, host, port] = match;
            console.log('[BullModule] 使用 Upstash Redis:', host, port);

            // 基础 Redis 配置（用于 createClient）
            const baseRedisOpts = {
              host,
              port: parseInt(port, 10),
              password,
              tls: protocol === 'rediss' ? {} : undefined,
              maxRetriesPerRequest: null, // Upstash 需要
              enableReadyCheck: false, // Upstash 需要
              // Upstash 推荐的轮询设置（减少 API 调用）
              retryStrategy: (times: number) => Math.min(times * 100, 3000),
            };

            // 创建可复用的客户端连接
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const Redis = require('ioredis');
            const sharedClient = new Redis(baseRedisOpts);
            const sharedSubscriber = new Redis(baseRedisOpts);

            console.log('[BullModule] 创建独立的 client/subscriber/bclient 连接');

            return {
              // 使用 createClient 为每种连接类型提供正确的 Redis 实例
              // 关键：bclient 必须是独立的连接，用于 BRPOPLPUSH 阻塞操作
              createClient: (type: 'client' | 'subscriber' | 'bclient') => {
                switch (type) {
                  case 'client':
                    console.log('[BullModule] createClient: client (复用)');
                    return sharedClient;
                  case 'subscriber':
                    console.log('[BullModule] createClient: subscriber (复用)');
                    return sharedSubscriber;
                  case 'bclient':
                    // bclient 必须是独立连接，不能复用！
                    console.log('[BullModule] createClient: bclient (新建独立连接)');
                    return new Redis(baseRedisOpts);
                  default:
                    throw new Error(`Unknown Redis connection type: ${type}`);
                }
              },
              defaultJobOptions: {
                removeOnComplete: 100, // 保留最近 100 个完成的任务
                removeOnFail: 1000, // 保留最近 1000 个失败的任务（用于排查）
              },
              // Upstash 推荐的队列设置
              settings: {
                stalledInterval: 30000, // 30秒检查卡住的任务（默认 30s）
                lockDuration: 60000, // 任务锁定时间 60 秒（防止重复处理）
                lockRenewTime: 15000, // 每 15 秒续锁
                maxStalledCount: 2, // 最多允许卡住 2 次
              },
            };
          } else {
            console.log('[BullModule] Upstash URL 格式无法解析');
          }
        }

        // 其次使用通用 REDIS_URL
        const redisUrl = configService.get<string>('REDIS_URL');
        if (redisUrl) {
          // 解析 Redis URL
          const match = redisUrl.match(/^(rediss?):\/\/(?:([^:]+):)?([^@]+)@([^:]+):(\d+)$/);
          if (match) {
            const [, protocol, , password, host, port] = match;
            console.log('[BullModule] 使用通用 REDIS_URL:', host, port);
            return {
              redis: {
                host,
                port: parseInt(port, 10),
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

        // 最后使用分离的配置（兜底：本地 Redis）
        console.log('[BullModule] 使用本地 Redis 配置 (fallback)');
        return {
          redis: {
            host: configService.get<string>('REDIS_HOST', 'localhost'),
            port: parseInt(configService.get<string>('REDIS_PORT', '6379'), 10),
            password: configService.get<string>('REDIS_PASSWORD'),
            tls: configService.get<string>('REDIS_TLS', 'false') === 'true' ? {} : undefined,
            maxRetriesPerRequest: null, // Upstash 需要
            enableReadyCheck: false, // Upstash 需要
          },
          defaultJobOptions: {
            removeOnComplete: 100,
            removeOnFail: 1000,
          },
        };
      },
      inject: [ConfigService],
    }),
    // 注册消息聚合队列
    BullModule.registerQueueAsync({
      name: 'message-merge',
      imports: [ConfigModule],
      useFactory: async () => ({
        // 队列配置
        defaultJobOptions: {
          attempts: 3, // 失败重试 3 次
          backoff: {
            type: 'exponential',
            delay: 2000, // 2秒后重试
          },
          removeOnComplete: true, // 完成后自动删除
          removeOnFail: false, // 失败保留用于调试
        },
      }),
    }),
  ],
  controllers: [MessageController],
  providers: [
    // 主服务
    MessageService,
    MessageProcessor,
    // 子服务（8个核心服务，按职责分类）
    MessageDeduplicationService, // 消息去重
    MessageHistoryService, // 消息历史
    MessageFilterService, // 消息过滤
    SimpleMergeService, // 简化版消息聚合（使用 Bull Queue 原生能力）
    MessageStatisticsService, // 统计监控
    TypingDelayService, // 智能打字延迟
    MessageDeliveryService, // 消息发送（统一分段发送和监控）
    AgentGatewayService, // Agent 调用网关（增强版：包含上下文构建、降级处理和降级话术）
    MessageCallbackAdapterService, // 消息回调适配器（支持小组级和企业级格式）
    MessagePipelineService, // 消息处理管线（核心处理逻辑）
    BookingDetectionService, // 预约成功检测
  ],
  exports: [MessageService, MessageFilterService, MessageHistoryService, MessageProcessor],
})
export class MessageModule {}
