import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * `MEMORY_SESSION_TTL_DAYS` 未配置时的默认天数。
 *
 * 短期 list 缓存（memory:short_term:chat:{chatId}）被两条写路径续期：
 * memory 侧 MessageWindowService backfill 与 biz 侧 ChatSessionService append。
 * 两处必须引用此常量作为默认值——默认值不同会让缓存实际生命周期
 * 取决于最后一次写入来自哪条路径。
 */
export const MEMORY_SESSION_TTL_DAYS_DEFAULT = '3';

/**
 * `MAX_HISTORY_PER_CHAT` 未配置时的默认条数：短期 list 缓存与 DB 单次回查共用的硬上限。
 *
 * 这是物理封顶不是语义窗口——语义窗口是滚动 7 天（historyWindowSeconds）与字符预算
 * （sessionWindowMaxChars）。取值须远高于窗口内的真实条数（生产 7 天内 p99≈90、峰值 <200），
 * 让它永远不先于窗口生效；两条读写路径必须引用同一常量，否则 list 裁剪与回查条数漂移。
 */
export const MEMORY_WINDOW_MAX_MESSAGES_DEFAULT = '300';

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
   * 控制 session-state 所辖结构化状态写进 Redis 的会话级数据过期时间，
   * 包括：候选人事实、候选岗位池、已展示岗位、当前焦点岗位、当前阶段等临时状态。
   *
   * ⚠️ 此 TTL 只控制 Redis key 的存活时长，不影响：
   *    - Supabase 历史消息的回查窗口（由 `historyWindowSeconds` 控制）
   *    - 会话沉淀的间隙判定阈值（由 `consolidationGapSeconds` 控制）
   */
  readonly sessionTtl: number;

  /**
   * `factsv2:` hash 的实际 TTL（秒）：咨询生命周期基准 + 12 小时沉淀读取余量。
   *
   * Redis hash 不支持字段级 TTL，因此同 key 中的 facts 与 workbench 投影会一起享有
   * 这段余量；`stage:` 与 collection-form 仍严格使用 `sessionTtl`。
   */
  readonly sessionFactsTtl: number;

  /**
   * 沉淀间隙阈值（秒）。
   *
   * 每回合结束按此阈值刷新 delayed job；任务到点后还会用 DB 最新消息时间复核
   * 闲置已达标。它与 `sessionTtl` 同为 3 天，使 episode 边界与咨询状态生命周期
   * 对齐；`MEMORY_SETTLEMENT_GAP_DAYS` 不得配成小于 sessionTtl——否则会话存活
   * 期间即发生沉淀，会话会读回自己刚沉淀的长期记忆（badcase 蒋强）。
   * `sessionFactsTtl` 额外保留 12 小时，保证定时沉淀先读后过期。
   */
  readonly consolidationGapSeconds: number;

  /**
   * 滚动历史窗口（秒）：从「本批之前候选人最后一次开口」往前回看多久。
   *
   * 锚点不是当前时间：候选人隔半月回访时，按 now 回看 7 天必然为空、只剩长期记忆；
   * 锚在上一次开口，回访能捡回上一段咨询的最后 7 天原文，连续咨询时两者等价。
   * 与 `sessionTtl` 分离：会话状态（Redis facts）过期是正常的，原文仍要能追溯。
   * 锚点在 MessageWindowService 内推导，调用方不传批次边界。
   *
   * 默认 7 天（MEMORY_HISTORY_WINDOW_DAYS）。
   */
  readonly historyWindowSeconds: number;

  /** 短期窗口单次读取 / 缓存的硬上限条数（物理封顶，非语义窗口；见 MEMORY_WINDOW_MAX_MESSAGES_DEFAULT）。 */
  readonly sessionWindowMaxMessages: number;

  /** 单轮会话窗口最多保留多少字符。超过后从最早消息开始裁剪。 */
  readonly sessionWindowMaxChars: number;

  /** 已有 facts 时，结构化事实提取只重看最近多少条历史消息。 */
  readonly sessionExtractionIncrementalMessages: number;

  /** 长期记忆整行数据在 Redis 中的缓存时长（秒）。 */
  readonly longTermCacheTtl: number;

  constructor(private readonly configService: ConfigService) {
    const days = parseInt(
      this.configService.get('MEMORY_SESSION_TTL_DAYS', MEMORY_SESSION_TTL_DAYS_DEFAULT),
      10,
    );
    this.sessionTtl = days * 24 * 60 * 60;
    this.sessionFactsTtl = this.sessionTtl + 12 * 60 * 60;

    const consolidationGapDays = parseInt(
      this.configService.get('MEMORY_SETTLEMENT_GAP_DAYS', '3'),
      10,
    );
    this.consolidationGapSeconds = consolidationGapDays * 24 * 60 * 60;

    const historyDays = parseInt(this.configService.get('MEMORY_HISTORY_WINDOW_DAYS', '7'), 10);
    this.historyWindowSeconds = historyDays * 24 * 60 * 60;

    this.sessionWindowMaxMessages = parseInt(
      this.configService.get('MAX_HISTORY_PER_CHAT', MEMORY_WINDOW_MAX_MESSAGES_DEFAULT),
      10,
    );
    this.sessionWindowMaxChars = parseInt(
      this.configService.get('AGENT_MAX_INPUT_CHARS', '24000'),
      10,
    );
    this.sessionExtractionIncrementalMessages = parseInt(
      this.configService.get('SESSION_EXTRACTION_INCREMENTAL_MESSAGES', '10'),
      10,
    );
    this.longTermCacheTtl = 2 * 60 * 60; // 2h

    this.logger.log(
      `MemoryConfig: sessionTtl=${days}d, consolidationGap=${consolidationGapDays}d, historyWindow=${historyDays}d, windowMessages=${this.sessionWindowMaxMessages}, windowChars=${this.sessionWindowMaxChars}, extractionIncremental=${this.sessionExtractionIncrementalMessages}`,
    );
  }

  /** 把 sessionTtl 换算成天数，供按天计算的逻辑复用。 */
  get sessionTtlDays(): number {
    return this.sessionTtl / (24 * 60 * 60);
  }
}
