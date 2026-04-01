import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 记忆模块配置
 *
 * 统一管理记忆相关的时间、窗口和缓存参数。
 *
 * 约定：
 * - 会话窗口：每轮进入 Agent 前，短期记忆最多读取多少条消息、保留多少字符
 * - 会话提取窗口：已有 facts 时，事实提取只重看最近多少条历史
 * - 长期记忆缓存：长期记忆整行数据在 Redis 中缓存多久，用来减少 Supabase 读压力
 */
@Injectable()
export class MemoryConfig {
  private readonly logger = new Logger(MemoryConfig.name);

  /**
   * 当前会话最多保留多久（秒）。
   *
   * 作用：
   * - `session.service` 和 `procedural.service` 写进 Redis 的会话级数据，会按这个时长自动过期
   * - 这些数据包括：候选人事实、候选岗位池、已展示岗位、当前焦点岗位、当前阶段等临时状态
   * - 如果用户在这段时间内一直没有继续发消息，就认为这一段会话已经结束
   * - 会话结束后，这段会话里的信息才有机会被沉淀到长期记忆
   */
  readonly sessionTtl: number;

  /** 单轮会话窗口最多读取多少条历史消息。 */
  readonly sessionWindowMaxMessages: number;

  /** 单轮会话窗口最多保留多少字符。超过后从最早消息开始裁剪。 */
  readonly sessionWindowMaxChars: number;

  /** 已有 facts 时，结构化事实提取只重看最近多少条历史消息。 */
  readonly sessionExtractionIncrementalMessages: number;

  /** 长期记忆整行数据在 Redis 中的缓存时长（秒）。 */
  readonly longTermCacheTtl: number;

  constructor(private readonly configService: ConfigService) {
    const days = parseInt(this.configService.get('MEMORY_SESSION_TTL_DAYS', '1'), 10);
    this.sessionTtl = days * 24 * 60 * 60;

    this.sessionWindowMaxMessages = parseInt(
      this.configService.get('MAX_HISTORY_PER_CHAT', '60'),
      10,
    );
    this.sessionWindowMaxChars = parseInt(
      this.configService.get('AGENT_MAX_INPUT_CHARS', '8000'),
      10,
    );
    this.sessionExtractionIncrementalMessages = parseInt(
      this.configService.get('SESSION_EXTRACTION_INCREMENTAL_MESSAGES', '10'),
      10,
    );
    this.longTermCacheTtl = 2 * 60 * 60; // 2h

    this.logger.log(
      `MemoryConfig: sessionTtl=${days}d, windowMessages=${this.sessionWindowMaxMessages}, windowChars=${this.sessionWindowMaxChars}, extractionIncremental=${this.sessionExtractionIncrementalMessages}`,
    );
  }

  /** 把 sessionTtl 换算成天数，供按天计算的逻辑复用。 */
  get sessionTtlDays(): number {
    return this.sessionTtl / (24 * 60 * 60);
  }
}
