import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 记忆系统时间常量统一管理
 *
 * 所有记忆相关的时间配置集中在此，围绕"单次求职服务周期"这一核心概念：
 * - SESSION_TTL: 会话记忆的 Redis TTL，同时决定空闲超时和短期记忆时间窗口
 * - 修改 SESSION_TTL 即可统一调整所有会话级时间参数
 */
@Injectable()
export class MemoryConfig {
  private readonly logger = new Logger(MemoryConfig.name);

  /** 服务周期时长（秒） — 所有会话级时间的基准 */
  readonly sessionTtl: number;

  /** 短期记忆最大消息条数 */
  readonly shortTermMaxMessages: number;

  /** 短期记忆总字符上限 */
  readonly shortTermMaxChars: number;

  /** Profile Redis 缓存时间（秒） */
  readonly profileCacheTtl: number;

  constructor(private readonly configService: ConfigService) {
    const days = parseInt(this.configService.get('MEMORY_SESSION_TTL_DAYS', '1'), 10);
    this.sessionTtl = days * 24 * 60 * 60;

    this.shortTermMaxMessages = parseInt(this.configService.get('MAX_HISTORY_PER_CHAT', '60'), 10);
    this.shortTermMaxChars = parseInt(this.configService.get('AGENT_MAX_INPUT_CHARS', '8000'), 10);
    this.profileCacheTtl = 2 * 60 * 60; // 2h

    this.logger.log(
      `MemoryConfig: sessionTtl=${days}d, maxMessages=${this.shortTermMaxMessages}, maxChars=${this.shortTermMaxChars}`,
    );
  }

  /** 服务周期天数（用于 Supabase 时间查询） */
  get sessionTtlDays(): number {
    return this.sessionTtl / (24 * 60 * 60);
  }
}
