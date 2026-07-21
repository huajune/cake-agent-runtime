/**
 * 会话品牌状态存取（§9.1）。
 *
 * memory 侧不含任何迁移规则，只做「读 brand_state → 调 reducer 纯函数 → 单字段写回」；
 * 迁移规则全部在 resolution/brand/brand-state.reducer.ts。写入时机：
 * - 常规轮：turn-finalizer 收尾序列（memory-lifecycle 的 apply_brand_state 步骤，
 *   排在 extract_facts 之后且不因其失败跳过），全程在渠道层 90s 租约处理锁内；
 * - 异步补写（§10.3）：图片描述晚到，由渠道层重新持锁后调 applyLateImageResolutions，
 *   带「过期即弃」防护。
 *
 * 首次初始化（懒迁移，§9.4）：旧 preferences.brands 末位品牌 > 已验证昵称品牌 seed > 空；
 * seed 状态在首轮回合准备阶段即经 deriveTurnBrandContext 构造生效（注入提示词、供工具兜底），
 * 持久化仍随收尾 reducer 统一落盘。
 */

import { Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import {
  ShadowAgreementCounter,
  SHADOW_AGREEMENT_BATCH,
  SHADOW_AGREEMENT_MAX_LAG_MS,
} from '@observability/shadow-agreement-counter';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import { buildBrandCatalogIndex } from '@resolution/brand/catalog-index';
import { buildExactMatchTokens, normalizeForBrandMatch } from '@resolution/brand/brand-normalize';
import {
  brandStateChanged,
  initBrandState,
  reduceBrandState,
  shouldDropLateResolutions,
} from '@resolution/brand/brand-state.reducer';
import type {
  BrandResolution,
  PersistedBrandState,
  SessionBrandRef,
  SessionBrandState,
} from '@resolution/brand/brand-resolution.types';
import { BRAND_EXECUTABLE_CONFIDENCE } from '@resolution/brand/brand-resolution.types';
import type { BrandItem } from '@/sponge/sponge.types';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import {
  PersistedBrandStateSchema,
  unwrapSessionFactValue,
  type SessionFacts,
} from '../types/session-facts.types';

export interface TurnBrandContext {
  /** 本轮生效的品牌状态：已持久化状态，或首轮 seed 出的初始状态（未落盘）。 */
  state: SessionBrandState;
  /** brand_state 是否已在 Redis 存在（存在即 seed 已发生，旧昵称兜底档按此门控）。 */
  persisted: boolean;
  /** 昵称经品牌库验证出的标准品牌名（提示词"备注品牌"线索兼容用）。 */
  nicknameBrands: string[];
}

@Injectable()
export class BrandStateService implements OnModuleDestroy {
  private readonly logger = new Logger(BrandStateService.name);

  /** 异步补写「过期即弃」计数（轻量观测，§12：走日志聚合，不新增事件类型）。 */
  private lateDropCount = 0;

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
    private readonly sponge: SpongeService,
    @Optional()
    private readonly tracer?: AgentTracerService,
  ) {}

  /**
   * 回合准备阶段派生本轮品牌上下文（§5.3 锚点一）。
   *
   * brand_state 已存在（哪怕被 browse_all 清成空值）时永不重新 seed；
   * 不存在时按「旧并集末位 > 昵称 seed > 空」构造初始状态供本轮使用。
   */
  async deriveTurnBrandContext(params: {
    persisted: PersistedBrandState | null | undefined;
    facts: SessionFacts | null;
    contactName?: string;
  }): Promise<TurnBrandContext> {
    const nicknameSeed = await this.resolveNicknameSeed(params.contactName);
    if (params.persisted) {
      return {
        state: params.persisted,
        persisted: true,
        nicknameBrands: nicknameSeed.brands,
      };
    }
    const legacyLastBrand = await this.deriveLegacyLastBrand(params.facts);
    return {
      state: initBrandState({ legacyLastBrand, nicknameSeed: nicknameSeed.seed }),
      persisted: false,
      nicknameBrands: nicknameSeed.brands,
    };
  }

  /**
   * 回合收尾统一写入（§5.3 锚点二）：汇总本轮全部解析结果批量过 reducer，单字段原子替换。
   * brand_state 不存在时先执行一次初始化（prevState = seed 状态）再应用本轮结果。
   */
  async applyTurnResolutions(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    resolutions: BrandResolution[];
    contactName?: string;
    /** 回合收尾开头已读出的会话状态（避免重复 HGETALL）；缺省时内部补读。 */
    persistedBrandState?: PersistedBrandState | null;
    facts?: SessionFacts | null;
  }): Promise<{ changed: boolean; initialized: boolean }> {
    const persisted =
      params.persistedBrandState !== undefined
        ? params.persistedBrandState
        : await this.readBrandState(params.corpId, params.userId, params.sessionId);

    let prev: SessionBrandState;
    let initialized = false;
    if (persisted) {
      prev = persisted;
    } else {
      const nicknameSeed = await this.resolveNicknameSeed(params.contactName);
      const legacyLastBrand = await this.deriveLegacyLastBrand(params.facts ?? null);
      prev = initBrandState({ legacyLastBrand, nicknameSeed: nicknameSeed.seed });
      initialized = true;
    }

    const next = reduceBrandState(prev, params.resolutions);
    const changed = brandStateChanged(prev, next);

    // 初始化必须落盘（seed 只此一次的锚点是"字段存在"）；已存在状态只有变化才写。
    if (initialized || changed) {
      await this.writeBrandState(params.corpId, params.userId, params.sessionId, {
        ...next,
        updatedAtMs: Date.now(),
      });
    }
    if (changed || initialized) {
      this.emitStateChange({
        corpId: params.corpId,
        userId: params.userId,
        sessionId: params.sessionId,
        prev: initialized ? null : prev,
        next,
        resolutions: params.resolutions,
        initialized,
        late: false,
      });
    }
    return { changed, initialized };
  }

  /**
   * 异步补写落状态（§10.3）：调用方必须已重新持有该会话的处理锁。
   * 携带产生轮次时间戳，早于 brand_state 最后变更时间的晚到结果只弃不写（防时间倒流）。
   */
  async applyLateImageResolutions(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    resolutions: BrandResolution[];
    resolutionTurnMs: number;
  }): Promise<'applied' | 'dropped_expired' | 'noop'> {
    if (params.resolutions.length === 0) return 'noop';

    const persisted = await this.readBrandState(params.corpId, params.userId, params.sessionId);
    if (persisted && shouldDropLateResolutions(persisted, params.resolutionTurnMs)) {
      this.lateDropCount += 1;
      this.logger.warn(
        `[brand-state] 图片补写过期丢弃（累计 ${this.lateDropCount} 次）：` +
          `补写轮次 ${params.resolutionTurnMs} 早于状态最后变更 ${persisted.updatedAtMs}，` +
          `sessionId=${params.sessionId}`,
      );
      return 'dropped_expired';
    }

    const prev: SessionBrandState = persisted ?? initBrandState({});
    const next = reduceBrandState(prev, params.resolutions);
    const changed = brandStateChanged(prev, next);
    if (!changed && persisted) return 'noop';

    await this.writeBrandState(params.corpId, params.userId, params.sessionId, {
      ...next,
      updatedAtMs: Date.now(),
    });
    this.emitStateChange({
      corpId: params.corpId,
      userId: params.userId,
      sessionId: params.sessionId,
      prev: persisted ? prev : null,
      next,
      resolutions: params.resolutions,
      initialized: !persisted,
      late: true,
    });
    return 'applied';
  }

  /** 读取 brand_state 单字段（经 zod 校验，坏数据按不存在处理）。 */
  async readBrandState(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<PersistedBrandState | null> {
    const hash = await this.redisStore.getHash(this.buildHashKey(corpId, userId, sessionId));
    const raw = hash?.brand_state;
    if (raw == null) return null;
    const parsed = PersistedBrandStateSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`[brand-state] Redis 中的 brand_state 校验失败，按不存在处理`);
      return null;
    }
    return parsed.data as PersistedBrandState;
  }

  private async writeBrandState(
    corpId: string,
    userId: string,
    sessionId: string,
    state: PersistedBrandState,
  ): Promise<void> {
    await this.redisStore.patchHash(
      this.buildHashKey(corpId, userId, sessionId),
      { brand_state: state },
      this.config.sessionTtl,
    );
  }

  /** 昵称品牌 seed：品牌库唯一命中才作数（多命中/歧义/未命中一律不 seed）。 */
  private async resolveNicknameSeed(
    contactName?: string,
  ): Promise<{ seed: SessionBrandRef | null; brands: string[] }> {
    const trimmed = contactName?.trim();
    if (!trimmed) return { seed: null, brands: [] };
    try {
      const catalog = await this.sponge.fetchBrandList();
      const resolutions = resolveBrands(trimmed, 'contact_name', catalog).filter(
        (r) =>
          !r.ambiguous && r.canonicalName !== null && r.confidence >= BRAND_EXECUTABLE_CONFIDENCE,
      );
      const brands = Array.from(new Set(resolutions.map((r) => r.canonicalName!)));
      this.emitNicknameShadowDiff(trimmed, brands, catalog);
      if (brands.length !== 1) return { seed: null, brands };
      const first = resolutions.find((r) => r.canonicalName === brands[0])!;
      return {
        seed: { canonicalName: first.canonicalName!, brandId: first.brandId },
        brands,
      };
    } catch (error) {
      this.logger.warn(
        `[brand-state] 昵称品牌解析失败（按无 seed 降级）: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { seed: null, brands: [] };
    }
  }

  /** 新旧昵称品牌匹配一致计数（§12：一致时仅计数不落行）。 */
  /**
   * 昵称路径的一致计数（§15.6 分母）。原实现只 logger.log，从不落库——contact_name 的
   * diff 因此长期没有可配对的分母，差异率只能算 extraction_hints 一侧（2026-07-21 发现）。
   */
  private readonly nicknameShadowAgreement = new ShadowAgreementCounter(
    SHADOW_AGREEMENT_BATCH,
    SHADOW_AGREEMENT_MAX_LAG_MS,
  );

  onModuleDestroy(): void {
    const flushed = this.nicknameShadowAgreement.drain();
    if (flushed > 0) this.emitNicknameShadowAgreement(flushed);
  }

  private emitNicknameShadowAgreement(batchSize: number): void {
    this.tracer?.emit({
      type: 'brand_resolution_shadow_agreement',
      batchSize,
      origin: 'contact_name',
    });
    this.logger.log(
      `[brand-shadow] 新旧昵称品牌匹配一致落库 ${batchSize} 次，累计 ${this.nicknameShadowAgreement.totalCount} 次（contact_name）`,
    );
  }

  /**
   * 昵称品牌的新旧路径并行对比（§15.2，origin=contact_name）。
   * 旧路径 = 原 deriveContactBrandAliases 的 detectBrandAliasHints 匹配（token 全等 +
   * 长别称包含 + 品类兜底）；不一致才落 brand_resolution_shadow_diff 事件。
   */
  private emitNicknameShadowDiff(
    nickname: string,
    nextBrands: string[],
    catalog: BrandItem[],
  ): void {
    const legacyBrands = legacyNicknameBrandMatch(nickname, catalog).sort();
    const sortedNext = [...nextBrands].sort();
    const identical =
      legacyBrands.length === sortedNext.length &&
      legacyBrands.every((brand, index) => brand === sortedNext[index]);
    if (identical) {
      // 空对空不是证据（昵称里本来就没品牌），不计入门禁分母。
      if (legacyBrands.length === 0) return;
      const flushed = this.nicknameShadowAgreement.record();
      if (flushed > 0) this.emitNicknameShadowAgreement(flushed);
      return;
    }
    this.tracer?.emit({
      type: 'brand_resolution_shadow_diff',
      inputs: [nickname],
      legacyBrands,
      nextBrands: sortedNext,
      catalogSize: catalog.length,
      origin: 'contact_name',
    });
  }

  /** 懒迁移：旧 preferences.brands 末位品牌（≈最近表达），经目录回查补品牌 ID。 */
  private async deriveLegacyLastBrand(facts: SessionFacts | null): Promise<SessionBrandRef | null> {
    const brands = unwrapSessionFactValue(facts?.preferences?.brands) as string[] | null;
    const last = brands?.filter((b) => typeof b === 'string' && b.trim())?.at(-1);
    if (!last) return null;
    let catalog: BrandItem[] = [];
    try {
      catalog = await this.sponge.fetchBrandList();
    } catch {
      catalog = [];
    }
    const exact = catalog.find((brand) => brand.name === last);
    // 旧数组存的是当年验证过的标准名；目录里已下架的品牌保留名称、ID 置空
    return { canonicalName: last, brandId: typeof exact?.id === 'number' ? exact.id : null };
  }

  private emitStateChange(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    prev: SessionBrandState | null;
    next: SessionBrandState;
    resolutions: BrandResolution[];
    initialized: boolean;
    late: boolean;
  }): void {
    this.tracer?.emit({
      type: 'brand_state_change',
      corpId: params.corpId,
      userId: params.userId,
      chatId: params.sessionId,
      prev: params.prev,
      next: params.next,
      triggers: params.resolutions.map((r) => ({
        source: r.source,
        polarity: r.intentPolarity,
        canonicalName: r.canonicalName,
        matchType: r.matchType,
        matchedText: r.matchedText,
        sourceText: r.sourceText,
        confidence: r.confidence,
      })),
      initialized: params.initialized,
      late: params.late,
    });
  }

  /** 与 SessionService 相同的 factsv2 hash key（同一存储，单字段读写）。 */
  private buildHashKey(corpId: string, userId: string, sessionId: string): string {
    return `factsv2:${corpId}:${userId}:${sessionId}`;
  }
}

/**
 * 旧昵称品牌匹配算法（对照组，随旧匹配路径按 §15.6 指标门下线）：
 * 与迁移前 deriveContactBrandAliases 使用的 detectBrandAliasHints 行为一致
 * （token 全等 + 长别称整句包含 + 品类兜底），基于已迁移的归一化原语重建。
 */
function legacyNicknameBrandMatch(nickname: string, catalog: BrandItem[]): string[] {
  if (!nickname || catalog.length === 0) return [];
  const index = buildBrandCatalogIndex(catalog);
  const tokens = buildExactMatchTokens(nickname);
  if (tokens.length === 0) return [];
  const normalized = normalizeForBrandMatch(nickname);

  const brands = new Set<string>();
  for (const candidate of index.candidates) {
    const matched =
      tokens.some((token) => token === candidate.normalized) ||
      (candidate.containEligible && normalized.includes(candidate.normalized));
    if (matched) brands.add(candidate.brandName);
  }
  if (brands.size === 0) {
    for (const category of index.categories) {
      if (!category.keywords.some((keyword) => normalized.includes(keyword))) continue;
      for (const brandName of category.brands) brands.add(brandName);
    }
  }
  return Array.from(brands);
}
