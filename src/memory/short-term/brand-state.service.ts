/**
 * 会话品牌状态存取（§7.2）。
 *
 * memory 侧不含任何行为迁移规则，只做「读 facts.brand → 调 reducer 纯函数 → facts 字段写回」；
 * 迁移规则全部在 @resolution/brand/state-policy。写入时机：
 * - 常规轮：turn-finalizer 收尾序列（lifecycle 的 apply_brand_state 步骤，
 *   排在 extract_facts 之后且不因其失败跳过），全程在渠道层 90s 租约处理锁内；
 * - 异步补写（§8.3）：图片描述晚到，由渠道层重新持锁后调 applyLateImageResolutions，
 *   带「过期即弃」防护。
 *
 * 首次初始化（§7.3）：已验证昵称品牌 seed > 空（旧 preferences.brands 懒迁移档已于
 * 退役，§11）；seed 状态在首轮回合准备阶段即经 deriveTurnBrandContext
 * 构造生效（注入提示词、供工具兜底），持久化仍随收尾 reducer 统一落盘。
 */

import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SpongeService } from '@sponge/sponge.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { resolveBrands } from '@resolution/brand/brand-matcher';
import {
  brandStateChanged,
  initBrandState,
  adjudicateBrandState,
  shouldDropLateResolutions,
} from '@resolution/brand/state-policy';
import type {
  BrandResolution,
  PersistedBrandState,
  SessionBrandRef,
  SessionBrandState,
} from '@resolution/brand/brand-resolution.types';
import { BRAND_EXECUTABLE_CONFIDENCE } from '@resolution/brand/brand-resolution.types';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import {
  FALLBACK_EXTRACTION,
  PersistedBrandStateSchema,
  SessionFactsSchema,
  type SessionFacts,
} from './short-term.types';
import { buildSessionFactsHashKey } from './session-key';

export interface TurnBrandContext {
  /** 本轮生效的品牌状态：已持久化状态，或首轮 seed 出的初始状态（未落盘）。 */
  state: SessionBrandState;
  /** facts.brand 是否已在 Redis 存在（存在即 seed 已发生，旧昵称兜底档按此门控）。 */
  persisted: boolean;
  /** 昵称经品牌库验证出的标准品牌名（提示词"备注品牌"线索兼容用）。 */
  nicknameBrands: string[];
}

@Injectable()
export class BrandStateService {
  private readonly logger = new Logger(BrandStateService.name);

  /** 异步补写「过期即弃」计数（轻量观测，§10：升级飞书告警，不新增事件类型）。 */
  private lateDropCount = 0;

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
    private readonly sponge: SpongeService,
    @Optional()
    private readonly tracer?: AgentTracerService,
  ) {}

  /**
   * 回合准备阶段派生本轮品牌上下文（§2 锚点一）。
   *
   * facts.brand 已存在（哪怕被 browse_all 清成空值）时永不重新 seed；
   * 不存在时按「旧并集末位 > 昵称 seed > 空」构造初始状态供本轮使用。
   */
  async deriveTurnBrandContext(params: {
    persisted: PersistedBrandState | null | undefined;
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
    return {
      state: initBrandState({ nicknameSeed: nicknameSeed.seed }),
      persisted: false,
      nicknameBrands: nicknameSeed.brands,
    };
  }

  /**
   * 回合收尾统一写入（§2 锚点二）：汇总本轮全部解析结果批量过 reducer，单字段原子替换。
   * facts.brand 不存在时先执行一次初始化（prevState = seed 状态）再应用本轮结果。
   */
  async applyTurnResolutions(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    resolutions: BrandResolution[];
    contactName?: string;
    /** 回合收尾开头已读出的会话状态（避免重复 HGETALL）；缺省时内部补读。 */
    persistedBrandState?: PersistedBrandState | null;
  }): Promise<{ changed: boolean; initialized: boolean }> {
    // 歧义现场在入口无条件记录：歧义结果不写状态，若绑在"状态变化才发事件"上，
    // 纯歧义轮（冲突别名如「小龙」）整档零留痕（§11 观测债 修复）。
    this.emitAmbiguousResolutions(params, params.resolutions, false);

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
      prev = initBrandState({ nicknameSeed: nicknameSeed.seed });
      initialized = true;
    }

    const next = adjudicateBrandState(prev, params.resolutions);
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
   * 异步补写落状态（§8.3）：调用方必须已重新持有该会话的处理锁。
   * 携带产生轮次时间戳，早于 facts.brand 最后变更时间的晚到结果只弃不写（防时间倒流）。
   */
  async applyLateImageResolutions(params: {
    corpId: string;
    userId: string;
    sessionId: string;
    resolutions: BrandResolution[];
    resolutionTurnMs: number;
  }): Promise<'applied' | 'dropped_expired' | 'noop'> {
    if (params.resolutions.length === 0) return 'noop';

    // 歧义观测不受过期丢弃影响：歧义发生是事实，无论状态是否写入都要留痕。
    this.emitAmbiguousResolutions(params, params.resolutions, true);

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
    const next = adjudicateBrandState(prev, params.resolutions);
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

  /** 读取 facts.brand；旧顶层 brand_state 命中时懒迁移到新位置。 */
  async readBrandState(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<PersistedBrandState | null> {
    const hashKey = buildSessionFactsHashKey(corpId, userId, sessionId);
    const hash = await this.redisStore.getHash(hashKey);
    const parsedFacts = SessionFactsSchema.safeParse(hash?.facts ?? FALLBACK_EXTRACTION);
    if (parsedFacts.success && parsedFacts.data.brand) {
      return parsedFacts.data.brand as PersistedBrandState;
    }
    if (!parsedFacts.success && hash?.facts != null) {
      this.logger.warn(`[brand-state] Redis 中的 facts 校验失败，无法读取嵌套品牌状态`);
    }

    const legacyBrand = PersistedBrandStateSchema.safeParse(hash?.brand_state);
    if (!legacyBrand.success) {
      if (hash?.brand_state != null) {
        this.logger.warn(`[brand-state] Redis 中的旧顶层 brand_state 校验失败，按不存在处理`);
      }
      return null;
    }

    // 旧顶层字段只作读兼容；新嵌套值缺失且 facts 有效时回写，旧字段随 key TTL 自然过期。
    if (parsedFacts.success) {
      const migratedFacts: SessionFacts = {
        ...(parsedFacts.data as SessionFacts),
        brand: legacyBrand.data as PersistedBrandState,
      };
      try {
        await this.redisStore.patchHash(
          hashKey,
          { facts: migratedFacts },
          this.config.sessionFactsTtl,
        );
      } catch (error) {
        this.logger.warn(`[brand-state] 旧顶层 brand_state 懒迁移失败: ${toErrorMessage(error)}`);
      }
    }
    return legacyBrand.data as PersistedBrandState;
  }

  /**
   * 测试夹具专用直写（test-suite memory-fixture）。
   *
   * preferences.brands 已退役；用例预设的品牌意向必须以 facts.brand
   * 形态种入才对链路可见。生产路径禁止调用——生产写入仍只经 reducer
   * （applyTurnResolutions / applyLateImageResolutions，§7.1 单一写入方）。
   */
  async seedFixtureBrandState(
    corpId: string,
    userId: string,
    sessionId: string,
    state: PersistedBrandState,
  ): Promise<void> {
    await this.writeBrandState(corpId, userId, sessionId, state);
  }

  private async writeBrandState(
    corpId: string,
    userId: string,
    sessionId: string,
    state: PersistedBrandState,
  ): Promise<void> {
    const hashKey = buildSessionFactsHashKey(corpId, userId, sessionId);
    const hash = await this.redisStore.getHash(hashKey);
    const parsedFacts = SessionFactsSchema.safeParse(hash?.facts ?? FALLBACK_EXTRACTION);
    if (!parsedFacts.success) {
      throw new Error('cannot persist facts.brand because existing facts failed validation');
    }
    const facts: SessionFacts = {
      ...(parsedFacts.data as SessionFacts),
      brand: state,
    };
    await this.redisStore.patchHash(hashKey, { facts }, this.config.sessionFactsTtl);
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
      if (brands.length !== 1) return { seed: null, brands };
      const first = resolutions.find((r) => r.canonicalName === brands[0])!;
      return {
        seed: { canonicalName: first.canonicalName!, brandId: first.brandId },
        brands,
      };
    } catch (error) {
      this.logger.warn(
        `[brand-state] 昵称品牌解析失败（按无 seed 降级）: ${toErrorMessage(error)}`,
      );
      return { seed: null, brands: [] };
    }
  }

  /** 歧义词形现场（brand_resolution_ambiguous）：只挑 ambiguous 结果，无则不发。 */
  private emitAmbiguousResolutions(
    scope: { corpId: string; userId: string; sessionId: string },
    resolutions: BrandResolution[],
    late: boolean,
  ): void {
    const ambiguous = resolutions.filter((r) => r.ambiguous);
    if (ambiguous.length === 0) return;
    this.tracer?.emit({
      type: 'brand_resolution_ambiguous',
      corpId: scope.corpId,
      userId: scope.userId,
      chatId: scope.sessionId,
      items: ambiguous.map((r) => ({
        source: r.source,
        matchedText: r.matchedText,
        sourceText: r.sourceText,
        polarity: r.intentPolarity,
        candidates: (r.candidates ?? []).map((c) => ({
          canonicalName: c.canonicalName,
          brandId: c.brandId,
        })),
      })),
      late,
    });
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
        // 履历语境标记：true = 该命中被 reducer 按履历提及处理
        //（不顶替在位品牌）。每日观测据此核对闸门行为。
        historyContext: r.historyContext ?? false,
      })),
      initialized: params.initialized,
      late: params.late,
    });
  }
}
