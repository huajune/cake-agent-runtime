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
   * Redis 会话状态的生命周期（秒）。
   *
   * 控制 `session.service` 和 `procedural.service` 写进 Redis 的会话级数据的过期时间，
   * 包括：候选人事实、候选岗位池、已展示岗位、当前焦点岗位、当前阶段等临时状态。
   *
   * ⚠️ 此 TTL 只控制 Redis key 的存活时长，不影响：
   *    - Supabase 历史消息的回查窗口（由 `historyWindowSeconds` 控制）
   *    - 会话沉淀的间隙判定阈值（由 `settlementGapSeconds` 控制）
   */
  readonly sessionTtl: number;

  /**
   * 沉淀间隙阈值（秒）。
   *
   * 连续两条消息的时间差 ≥ 此阈值时，SettlementService 认为上一段会话已结束，
   * 触发摘要沉淀到长期记忆。
   *
   * 与 `sessionTtl` 分离的原因：Redis facts 的存活时长（sessionTtl）是"数据还在不在"，
   * 沉淀阈值是"对话是否已断"——两者可以独立调优。例如 sessionTtl=2天让隔天回来的用户
   * 仍有 facts 可用，而 settlementGap=1天让超过一天的间隙及时沉淀。
   */
  readonly settlementGapSeconds: number;

  /**
   * 从 Supabase 回查历史消息的时间窗口（秒）。
   *
   * 与 `sessionTtl` 分离的原因：会话状态（Redis facts）过期是正常的，
   * 但过期后用户回来续聊时，Agent 仍需要看到此前的对话历史来重建上下文。
   * 若两者共用同一个 TTL，会导致"跨天回来的用户被当新用户对待"的问题。
   *
   * 默认 7 天（MEMORY_HISTORY_WINDOW_DAYS）。
   */
  readonly historyWindowSeconds: number;

  /** 单轮会话窗口最多读取多少条历史消息。 */
  readonly sessionWindowMaxMessages: number;

  /** 单轮会话窗口最多保留多少字符。超过后从最早消息开始裁剪。 */
  readonly sessionWindowMaxChars: number;

  /** 已有 facts 时，结构化事实提取只重看最近多少条历史消息。 */
  readonly sessionExtractionIncrementalMessages: number;

  /** 长期记忆整行数据在 Redis 中的缓存时长（秒）。 */
  readonly longTermCacheTtl: number;

  constructor(private readonly configService: ConfigService) {
    const days = parseInt(this.configService.get('MEMORY_SESSION_TTL_DAYS', '2'), 10);
    this.sessionTtl = days * 24 * 60 * 60;

    const settlementGapDays = parseInt(
      this.configService.get('MEMORY_SETTLEMENT_GAP_DAYS', '1'),
      10,
    );
    this.settlementGapSeconds = settlementGapDays * 24 * 60 * 60;

    const historyDays = parseInt(this.configService.get('MEMORY_HISTORY_WINDOW_DAYS', '7'), 10);
    this.historyWindowSeconds = historyDays * 24 * 60 * 60;

    this.sessionWindowMaxMessages = parseInt(
      this.configService.get('MAX_HISTORY_PER_CHAT', '60'),
      10,
    );
    this.sessionWindowMaxChars = parseInt(
      this.configService.get('AGENT_MAX_INPUT_CHARS', '12000'),
      10,
    );
    this.sessionExtractionIncrementalMessages = parseInt(
      this.configService.get('SESSION_EXTRACTION_INCREMENTAL_MESSAGES', '10'),
      10,
    );
    this.longTermCacheTtl = 2 * 60 * 60; // 2h

    this.logger.log(
      `MemoryConfig: sessionTtl=${days}d, settlementGap=${settlementGapDays}d, historyWindow=${historyDays}d, windowMessages=${this.sessionWindowMaxMessages}, windowChars=${this.sessionWindowMaxChars}, extractionIncremental=${this.sessionExtractionIncrementalMessages}`,
    );
  }

  /** 把 sessionTtl 换算成天数，供按天计算的逻辑复用。 */
  get sessionTtlDays(): number {
    return this.sessionTtl / (24 * 60 * 60);
  }
}
