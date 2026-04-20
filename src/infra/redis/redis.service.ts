import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';

/**
 * Redis 服务（基于 Upstash）
 * 提供统一的 Redis 客户端，供所有模块使用
 *
 * 环境隔离：
 * - 所有 key 在内部统一加 `{RUNTIME_ENV|NODE_ENV}:` 前缀
 * - 多个环境共用同一个 Upstash Redis 时，key 物理隔离
 * - 调用方传入的 key 不需要包含环境段
 */
@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger = new Logger(RedisService.name);
  private redisClient: Redis;
  private readonly env: string;
  private readonly keyPrefix: string;

  constructor(private readonly configService: ConfigService) {
    this.env = (
      this.configService.get<string>('RUNTIME_ENV') ||
      this.configService.get<string>('NODE_ENV') ||
      'development'
    ).trim();
    this.keyPrefix = `${this.env}:`;
    this.initializeClient();
  }

  private initializeClient() {
    const redisUrl = this.configService.get<string>('UPSTASH_REDIS_REST_URL');
    const redisToken = this.configService.get<string>('UPSTASH_REDIS_REST_TOKEN');

    this.redisClient = new Redis({
      url: redisUrl,
      token: redisToken,
    });

    this.logger.log(`Redis 客户端已初始化（key 前缀: "${this.keyPrefix}"）`);
  }

  async onModuleInit() {
    try {
      await this.redisClient.ping();
      this.logger.log('✓ Redis 连接测试成功');
    } catch (error) {
      this.logger.error('✗ Redis 连接测试失败:', error);
      throw error;
    }
  }

  /** 给 key 加环境前缀 */
  private withPrefix(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** 批量给 key 加环境前缀 */
  private withPrefixAll(keys: string[]): string[] {
    return keys.map((key) => this.withPrefix(key));
  }

  /**
   * 获取 Redis 原始客户端
   *
   * @deprecated 直接使用原始客户端会绕过环境前缀（RUNTIME_ENV），可能导致跨环境数据污染。
   *   新代码请使用本服务暴露的方法（get/set/setNx/eval/incrby 等）；仅在对接 BullMQ
   *   这类要求传入 ioredis 实例的三方库时使用，且调用点需要自行维护 key 前缀隔离。
   */
  getClient(): Redis {
    return this.redisClient;
  }

  /** 当前环境标识，用于诊断 */
  getEnvironment(): string {
    return this.env;
  }

  // ==================== 通用 KV ====================

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.redisClient.get<T>(this.withPrefix(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.redisClient.set(this.withPrefix(key), value);
  }

  async setex(key: string, seconds: number, value: unknown): Promise<void> {
    await this.redisClient.setex(this.withPrefix(key), seconds, value);
  }

  /**
   * 原子 SET NX EX：仅当 key 不存在时设置，并附带 TTL。
   * 用于分布式锁、去重等场景。
   *
   * @returns true = 设置成功（首次写入）；false = key 已存在（被其他进程占据）
   */
  async setNx(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
    const result = await this.redisClient.set(this.withPrefix(key), value, {
      nx: true,
      ex: ttlSeconds,
    });
    return result === 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    return this.redisClient.del(...this.withPrefixAll(keys));
  }

  async exists(...keys: string[]): Promise<number> {
    return this.redisClient.exists(...this.withPrefixAll(keys));
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.redisClient.expire(this.withPrefix(key), seconds);
  }

  async incrby(key: string, delta: number): Promise<number> {
    return this.redisClient.incrby(this.withPrefix(key), delta);
  }

  /**
   * 执行 Lua 脚本，自动给 keys 数组加前缀。
   * args 不会被加前缀，按原样传给脚本。
   */
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return this.redisClient.eval(script, this.withPrefixAll(keys), args);
  }

  // ==================== List ====================

  async rpush(key: string, ...values: unknown[]): Promise<number> {
    return this.redisClient.rpush(this.withPrefix(key), ...values);
  }

  async lrange<T = unknown>(key: string, start: number, stop: number): Promise<T[]> {
    return this.redisClient.lrange<T>(this.withPrefix(key), start, stop);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.redisClient.ltrim(this.withPrefix(key), start, stop);
  }

  async llen(key: string): Promise<number> {
    return this.redisClient.llen(this.withPrefix(key));
  }

  // ==================== Set ====================

  async sadd(key: string, ...members: (string | number)[]): Promise<number> {
    if (members.length === 0) return 0;
    return this.redisClient.sadd(this.withPrefix(key), members[0], ...members.slice(1));
  }

  async sismember(key: string, member: string | number): Promise<number> {
    return this.redisClient.sismember(this.withPrefix(key), member);
  }

  // ==================== 扫描与连通性 ====================

  /**
   * 扫描键。match 模式会自动加环境前缀，count 透传。
   * 返回的 key 列表也会去掉前缀，保持调用方视角的纯净。
   */
  async scan(
    cursor: string | number,
    options?: { match?: string; count?: number },
  ): Promise<[string | number, string[]]> {
    const prefixedMatch = options?.match ? this.withPrefix(options.match) : undefined;
    const [next, keys] = await this.redisClient.scan(cursor, {
      match: prefixedMatch,
      count: options?.count,
    });
    const stripped = keys.map((key) =>
      key.startsWith(this.keyPrefix) ? key.slice(this.keyPrefix.length) : key,
    );
    return [next, stripped];
  }

  async ping(): Promise<string> {
    return this.redisClient.ping();
  }
}
