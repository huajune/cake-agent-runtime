import { toErrorMessage } from '@infra/utils/error.util';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CityAttestation } from '@shared-types/turn.types';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { SpongeService } from '@/sponge/sponge.service';
import { RedisStore } from '../stores/redis.store';
import { MemoryConfig } from '../memory.config';
import { z } from 'zod';
import {
  BrandIntentEntrySchema,
  type BrandIntentEntry,
  EntityExtractionResultSchema,
  LLMEntityExtractionResultSchema,
  LaborFormIntentExtractionSchema,
  type LaborFormIntentExtraction,
  type EntityExtractionResult,
  type InvitedGroupRecord,
  InvitedGroupRecordSchema,
  PersistedBrandStateSchema,
  SessionFactsSchema,
  SessionFactsRedisContentSchema,
  type SessionFacts,
  type SessionInterviewInfo,
  type SessionFactValue,
  type WeworkSessionState,
  EMPTY_SESSION_STATE,
  FALLBACK_EXTRACTION,
  isSessionFactValue,
  sessionFactValue,
  toSessionFacts,
  truncateEvidence,
  unwrapSessionFactValue,
} from './short-term.types';
import type { ReengagementSessionState, CollectedField } from '../recall.types';
import { parseCandidateFieldsFromText } from '@resolution/candidate';
import {
  buildSessionExtractionPrompt,
  SESSION_EXTRACTION_SYSTEM_PROMPT,
} from './extraction.prompt';
import { detectBrandAliasHints } from '@resolution/turn-hints/producers/rule-track';
import { isSameFactValue } from '@resolution/turn-hints/reducer';
import type { TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type {
  BrandResolution,
  PersistedBrandState,
} from '@resolution/brand/brand-resolution.types';
import { produceValidatedBrandIntents } from '@resolution/brand/intent-producer';
import { decideGeoPreferenceClear } from '@resolution/geo/preference-clear';
import { normalizeCityName } from '@resolution/geo';
import { adjudicateCityClaims, cityClaimFromFact } from '@resolution/geo/city-adjudicator';
import { decideLaborFormIntent, type LaborFormIntentDecision } from '@resolution/labor-form';
import { parseTimeContextAt, stripTimeContext } from '@resolution/signal/markers';
import { formatCurrentTime } from '@infra/utils/date.util';
import { buildSessionFactsHashKey } from './session-key';
import { hasMeaningfulValue, resolveTurnHints } from '@resolution/turn-hints/reducer';
import { factConfidenceRank } from '../confidence-rank';
import {
  MEMORY_CHAT_SESSION_PORT,
  MEMORY_SYSTEM_CONFIG_PORT,
  type MemoryChatSessionPort,
  type MemorySystemConfigPort,
} from '../memory.ports';

/**
 * 会话记忆·事实舱（semantic 性质）。
 *
 * 职责：会话状态存取（本舱是状态所有者）、结构化事实读写（置信度合并/extractedAt
 * 时间锚）、LLM 后置提取、已发生事件（invitedGroups/terminal/活动水位——复聊停发
 * 信号消费的都是事实）。工作台舱（注意力/查询状态）见 workbench.service.ts；
 * 对外聚合入口仍是 SessionStateService facade，跨域注入点只做机械正名。
 */

@Injectable()
export class SessionFactsService {
  private readonly logger = new Logger(SessionFactsService.name);

  /** 纯应答词判定的最大文本长度：超过即认为携带额外信息，不可跳过提取。 */
  private static readonly MAX_ACK_TEXT_LENGTH = 12;

  constructor(
    private readonly redisStore: RedisStore,
    private readonly config: MemoryConfig,
    private readonly llm: LlmExecutorService,
    private readonly sponge: SpongeService,
    @Inject(MEMORY_SYSTEM_CONFIG_PORT)
    private readonly systemConfig: MemorySystemConfigPort,
    @Optional()
    private readonly tracer?: AgentTracerService,
    @Optional()
    @Inject(MEMORY_CHAT_SESSION_PORT)
    private readonly chatSession?: MemoryChatSessionPort,
    @Optional()
    private readonly alertNotifier?: AlertNotifierService,
  ) {}

  // ==================== store ====================
  //
  // 存储形态：Redis hash（factsv2:*），每个 top-level 字段一个 hash field。
  //
  // 为什么不是单 JSON blob：save* 的"读整份-改-写整份"在并发写入方之间互相覆盖
  // （入站 fire-and-forget 的 recordCandidateActivity、复聊 processor 的
  // saveTerminalState 与 worker 回合收尾不持同一把锁，P0 丢更新）。hash 形态下
  // 每个 save* 只 HSET 自己的字段，跨字段并发写天然隔离。
  //
  // 同字段仍是 last-writer-wins：facts / presentedJobs / invitedGroups 的
  // "读-合并-写"依赖 chat 处理锁串行（同一 chat 的回合收尾在锁释放前 await 落盘），
  // 不持锁的写入方（activity/terminal）只碰各自独占的字段。
  //
  // 迁移：读时旧 blob（facts:*）与 hash 叠加（hash 字段优先），并用 HSETNX 把旧
  // blob 惰性回填进 hash 后删除旧 key；回填不会覆盖迁移窗口内的新写入。

  async getSessionState(
    corpId: string,
    userId: string,
    sessionId: string,
  ): Promise<WeworkSessionState> {
    // 这里统一返回完整的空态，避免调用方反复处理 null/undefined 的分支。
    const hashKey = buildSessionFactsHashKey(corpId, userId, sessionId);
    const legacyKey = this.buildKey(corpId, userId, sessionId);
    const hashFields = await this.redisStore.getHash(hashKey);

    // factsv2 命中后不再读取已经迁移并删除的 facts:* 旧 Key。
    // 生产数据已完成迁移；旧格式只在新 Hash 缺失时走一次兼容读取与惰性回填。
    const legacyEntry = hashFields ? null : await this.redisStore.get(legacyKey);

    const legacyContent =
      legacyEntry?.content && typeof legacyEntry.content === 'object'
        ? (legacyEntry.content as Record<string, unknown>)
        : null;
    if (legacyContent) {
      void this.migrateLegacyState(hashKey, legacyKey, legacyContent);
    }

    if (!hashFields && !legacyContent) return { ...EMPTY_SESSION_STATE };

    const combined = this.projectLegacyBrandState(hashFields ?? legacyContent ?? {}, hashKey, {
      corpId,
      userId,
      sessionId,
    });
    const content = this.parseSessionStateFields(combined, { corpId, userId, sessionId });

    return {
      ...EMPTY_SESSION_STATE,
      ...content,
      lastCandidatePool: content.lastCandidatePool ?? null,
      presentedJobs: content.presentedJobs ?? null,
      currentFocusJob: content.currentFocusJob ?? null,
    };
  }

  /**
   * 逐字段校验读出：坏字段丢弃并告警，其余字段照常返回。
   *
   * 为什么不是整份 safeParse：Redis 是 facts（含 brand）/ terminal 的唯一事实源，
   * 整份校验会把任一字段的 schema 漂移（跨版本词表不一致、脏写）放大成「整份会话状态
   * 归空」——终态一并丢失后，复聊会继续触达已约面/已转人工的候选人。降级粒度必须是字段。
   * 存储形态本就是按字段的 Redis hash（旧 blob 的 top-level 键同名），逐字段校验与之同构。
   *
   * **丢弃必须能被发现**：丢字段就是丢事实（丢 facts 是档案缺一块，丢 terminal 是复聊去
   * 骚扰已约面的人），只打日志等于没发生。故同时落 `agent_execution_events`（同 traceId
   * 可与回合流水 join）与飞书告警（AlertNotifierService 自带节流）。
   */
  private parseSessionStateFields(
    combined: Record<string, unknown>,
    scope: { corpId: string; userId: string; sessionId: string },
  ): Partial<WeworkSessionState> {
    const fieldSchemas = SessionFactsRedisContentSchema.shape as Record<string, z.ZodType>;
    const content: Record<string, unknown> = {};
    const invalidIssues: string[] = [];
    const droppedFields: string[] = [];

    for (const [field, rawValue] of Object.entries(combined)) {
      const fieldSchema = fieldSchemas[field];
      // 未注册字段：与整份 parse 的 strip 行为一致，静默丢弃。
      if (!fieldSchema) continue;

      const parsed = fieldSchema.safeParse(rawValue);
      if (!parsed.success) {
        droppedFields.push(field);
        invalidIssues.push(
          ...parsed.error.issues.map(
            (issue) =>
              `${[field, ...issue.path.map((segment) => String(segment))].join('.')}: ${issue.message}`,
          ),
        );
        continue;
      }
      if (parsed.data !== undefined) content[field] = parsed.data;
    }

    if (invalidIssues.length > 0) {
      this.reportDroppedStateFields(scope, droppedFields, invalidIssues);
    }

    return content as Partial<WeworkSessionState>;
  }

  /**
   * 旧 hash 顶层 brand_state 读时投影为 facts.brand，并回写新形态。
   *
   * 旧字段不主动 HDEL：同一 factsv2 key 的 TTL 会让它自然过期；迁移窗口内嵌套新值
   * 一旦存在即优先，绝不被旧顶层字段覆盖。
   */
  private projectLegacyBrandState(
    combined: Record<string, unknown>,
    hashKey: string,
    scope: { corpId: string; userId: string; sessionId: string },
  ): Record<string, unknown> {
    const legacyBrand = PersistedBrandStateSchema.safeParse(combined.brand_state);
    if (!legacyBrand.success) return combined;

    const parsedFacts = SessionFactsSchema.safeParse(combined.facts ?? FALLBACK_EXTRACTION);
    if (!parsedFacts.success || parsedFacts.data.brand) return combined;

    const migratedFacts: SessionFacts = {
      ...(parsedFacts.data as SessionFacts),
      brand: legacyBrand.data as PersistedBrandState,
    };
    void this.redisStore
      .patchHash(hashKey, { facts: migratedFacts }, this.config.sessionFactsTtl)
      .then(() => {
        this.logger.log(
          `[getSessionState] 顶层 brand_state 已懒迁移到 facts.brand: ` +
            `${scope.corpId}/${scope.userId}/${scope.sessionId}`,
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `[getSessionState] brand_state 懒迁移失败（下次读取重试）: ${toErrorMessage(error)}`,
        );
      });

    return { ...combined, facts: migratedFacts };
  }

  /**
   * 落盘态字段被丢弃的观测出口：日志 + 执行事件 + 飞书告警，一条都不省。
   *
   * 告警是 fire-and-forget：读会话状态在消息处理主链路上，告警通道抖动不得拖慢或
   * 打断它——但失败要留痕，否则"告警自己坏了"又成了没人知道的事。
   */
  private reportDroppedStateFields(
    scope: { corpId: string; userId: string; sessionId: string },
    droppedFields: string[],
    invalidIssues: string[],
  ): void {
    const detail = invalidIssues.join('; ');
    this.logger.warn(`[getSessionState] Invalid session facts field(s) dropped: ${detail}`);

    for (const field of droppedFields) {
      this.tracer?.emit({
        type: 'session_state_field_dropped',
        userId: scope.userId,
        field,
        // 只带 zod 的字段路径与原因，不带值本体——观测事件不进 PII。
        issues: invalidIssues.filter((issue) => issue.startsWith(`${field}.`)),
      });
    }

    void this.alertNotifier
      ?.sendSimpleAlert(
        '会话状态字段被丢弃（Redis 落盘态与 schema 失配）',
        [
          `会话：${scope.corpId}/${scope.userId}/${scope.sessionId}`,
          `丢弃字段：${droppedFields.join('、')}`,
          `明细：${detail}`,
          'Redis 是 facts（含 brand）/ terminal 的唯一事实源，丢字段即丢事实：',
          'facts 丢是档案缺块，terminal 丢会让复聊去骚扰已约面/已转人工的候选人。',
        ].join('\n'),
        'error',
      )
      .catch((error: unknown) => {
        this.logger.warn(`[getSessionState] 字段丢弃告警发送失败: ${toErrorMessage(error)}`);
      });
  }

  /**
   * 只写 patch 中的字段（HSET），其余字段不受影响。
   * 所有 save* 必须经此出口写入，禁止回到"读整份-写整份"。
   */
  async patchSessionState(
    corpId: string,
    userId: string,
    sessionId: string,
    patch: Partial<WeworkSessionState>,
  ): Promise<void> {
    const validated = this.serializeStateContent(patch) as Record<string, unknown>;
    await this.redisStore.patchHash(
      buildSessionFactsHashKey(corpId, userId, sessionId),
      validated,
      this.config.sessionFactsTtl,
    );
  }

  /** 旧版单 blob → hash 的惰性迁移（HSETNX 只补缺失字段，迁移后删旧 key）。 */
  private async migrateLegacyState(
    hashKey: string,
    legacyKey: string,
    legacyContent: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.redisStore.backfillHash(hashKey, legacyContent, this.config.sessionFactsTtl);
      await this.redisStore.del(legacyKey);
      this.logger.log(`[getSessionState] 旧版 session blob 已迁移为 hash: ${legacyKey}`);
    } catch (error) {
      const message = toErrorMessage(error);
      this.logger.warn(`[getSessionState] 旧版 session blob 迁移失败（下次读取重试）: ${message}`);
    }
  }

  async clearSessionState(corpId: string, userId: string, sessionId: string): Promise<boolean> {
    const [hashDeleted, legacyDeleted] = await Promise.all([
      this.redisStore.del(buildSessionFactsHashKey(corpId, userId, sessionId)),
      this.redisStore.del(this.buildKey(corpId, userId, sessionId)),
    ]);
    return hashDeleted || legacyDeleted;
  }

  async getFacts(corpId: string, userId: string, sessionId: string): Promise<SessionFacts | null> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return state.facts;
  }

  async getReengagementState(
    corpId: string,
    userId: string,
    sessionId: string,
    options?: { currentUserMessages?: readonly string[]; now?: number },
  ): Promise<ReengagementSessionState> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    return this.deriveReengagementState(state, options);
  }

  /**
   * 夹具/显式写入口：身份组精确替换，偏好组使用三态合并。
   *
   * 身份事实不再参与 deep merge；生产身份写入须走收资逐格或办结专用入口。
   */
  async saveFacts(
    corpId: string,
    userId: string,
    sessionId: string,
    facts: SessionFacts,
  ): Promise<void> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    const incoming = SessionFactsSchema.parse(facts) as SessionFacts;
    const merged = SessionFactsSchema.parse({
      interview_info: incoming.interview_info,
      preferences: this.mergePreferences(state.facts?.preferences ?? null, incoming.preferences),
      // brand 只由 BrandStateService reducer 写；通用 facts 写入必须原样保留。
      brand: state.facts?.brand ?? null,
    }) as SessionFacts;
    await this.patchSessionState(corpId, userId, sessionId, { facts: merged });
  }

  /**
   * 收资表单逐格落定的身份事实入口；只接受 medium 信封。
   *
   * source 保留槽位的真实作证者，collection 域血缘写在 evidence；这里负责守住
   * 同值不刷新与低置信不得覆盖高置信，调用方不需要复制合并规则。
   */
  async saveCollectionProgressFact(
    corpId: string,
    userId: string,
    sessionId: string,
    field: keyof SessionInterviewInfo,
    fact: SessionFactValue<string | boolean>,
  ): Promise<void> {
    if (!isSessionFactValue(fact) || fact.confidence !== 'medium') {
      throw new Error(`collection progress fact must be medium: ${String(field)}`);
    }
    if (!fact.evidence.startsWith('收资表单第 ')) {
      throw new Error(`collection progress fact evidence must identify the slot: ${String(field)}`);
    }

    const state = await this.getSessionState(corpId, userId, sessionId);
    const base = state.facts ?? (SessionFactsSchema.parse(FALLBACK_EXTRACTION) as SessionFacts);
    const current = base.interview_info[field];
    if (
      isSessionFactValue(current) &&
      (isSameFactValue(current.value, fact.value) ||
        factConfidenceRank(current.confidence) > factConfidenceRank(fact.confidence))
    ) {
      return;
    }

    const merged = SessionFactsSchema.parse({
      interview_info: { ...base.interview_info, [field]: fact },
      preferences: base.preferences,
      brand: base.brand,
    }) as SessionFacts;
    await this.patchSessionState(corpId, userId, sessionId, { facts: merged });
  }

  /** 收资表单办结的唯一身份写入口；仅接受 high 信封并保留未提交字段。 */
  async saveCompletedCollectionFacts(
    corpId: string,
    userId: string,
    sessionId: string,
    interviewInfo: Partial<SessionFacts['interview_info']>,
  ): Promise<void> {
    for (const [field, raw] of Object.entries(interviewInfo)) {
      if (raw !== null && (!isSessionFactValue(raw) || raw.confidence !== 'high')) {
        throw new Error(`collection form fact must be high: ${field}`);
      }
    }
    const state = await this.getSessionState(corpId, userId, sessionId);
    const base = state.facts ?? (SessionFactsSchema.parse(FALLBACK_EXTRACTION) as SessionFacts);
    const merged = SessionFactsSchema.parse({
      interview_info: { ...base.interview_info, ...interviewInfo },
      preferences: base.preferences,
      brand: base.brand,
    }) as SessionFacts;
    await this.patchSessionState(corpId, userId, sessionId, { facts: merged });
  }

  /** 轮末软事实写入口。外层 null=缺席；信封 value=null=显式墓碑；有值=替换。 */
  private async savePreferences(
    corpId: string,
    userId: string,
    sessionId: string,
    preferences: SessionFacts['preferences'],
  ): Promise<void> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    const base = state.facts ?? (SessionFactsSchema.parse(FALLBACK_EXTRACTION) as SessionFacts);
    const merged = SessionFactsSchema.parse({
      interview_info: base.interview_info,
      preferences: this.mergePreferences(base.preferences, preferences),
      brand: base.brand,
    }) as SessionFacts;
    await this.patchSessionState(corpId, userId, sessionId, { facts: merged });
  }

  private mergePreferences(
    previous: SessionFacts['preferences'] | null,
    incoming: SessionFacts['preferences'],
  ): SessionFacts['preferences'] {
    if (!previous) return incoming;
    const merged = { ...previous } as Record<string, unknown>;
    for (const [field, raw] of Object.entries(incoming)) {
      if (raw === null || raw === undefined) continue;
      const current = merged[field];
      if (
        isSessionFactValue(current) &&
        isSessionFactValue(raw) &&
        isSameFactValue(current.value, raw.value)
      ) {
        continue;
      }
      merged[field] = raw;
    }
    return merged as unknown as SessionFacts['preferences'];
  }

  /**
   * 城市写入统一走 adjudicateCityClaims；外部工具确权按 high 入档。
   */
  async saveToolAttestedCity(
    corpId: string,
    userId: string,
    sessionId: string,
    attestation: CityAttestation,
  ): Promise<'written' | 'skipped_same_city' | 'skipped_city_conflict' | 'skipped_invalid'> {
    const normalized = normalizeCityName(attestation.city);
    if (!normalized) return 'skipped_invalid';

    const state = await this.getSessionState(corpId, userId, sessionId);
    const previous = state.facts?.preferences.city ?? null;
    const incoming = cityClaimFromFact({
      value: normalized,
      confidence: 'high',
      source: 'system',
      evidence: attestation.evidence,
      extractedAt: new Date().toISOString(),
    });
    const adjudication = adjudicateCityClaims(cityClaimFromFact(previous), incoming);
    if (adjudication.decision === 'reject_invalid') return 'skipped_invalid';
    if (adjudication.decision === 'same_value') return 'skipped_same_city';
    if (adjudication.decision !== 'adopt') return 'skipped_city_conflict';

    const preferences = (
      SessionFactsSchema.parse({
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          city: sessionFactValue(normalized, {
            confidence: 'high',
            source: 'system',
            evidence: truncateEvidence(attestation.evidence),
            extractedAt: new Date().toISOString(),
          }),
        },
      }) as SessionFacts
    ).preferences;
    await this.savePreferences(corpId, userId, sessionId, preferences);
    return 'written';
  }

  private deriveReengagementState(
    state: WeworkSessionState,
    options?: { currentUserMessages?: readonly string[]; now?: number },
  ): ReengagementSessionState {
    const recalledJobIds = new Set<number>();
    for (const job of [
      ...(state.presentedJobs ?? []),
      ...(state.lastCandidatePool ?? []),
      ...(state.currentFocusJob ? [state.currentFocusJob] : []),
    ]) {
      if (Number.isFinite(job.jobId)) recalledJobIds.add(job.jobId);
    }

    // HC-2：当前轮候选人原文经 parser 解析为 candidate_quote；持久化 session facts
    // 仅用于跨轮状态判断（如 booking_incomplete 复聊停止条件），不作为模型工具参数自证。
    const persistedCollectedFields = this.projectCollectedFieldsFromSessionFacts(
      state.facts,
      options?.now ?? Date.now(),
    );
    const currentCollectedFields = options?.currentUserMessages?.length
      ? parseCandidateFieldsFromText(options.currentUserMessages, options.now ?? Date.now())
      : {};
    const collectedFields = { ...persistedCollectedFields, ...currentCollectedFields };

    const lastCandidateMessageAt = state.lastCandidateMessageAt
      ? Date.parse(state.lastCandidateMessageAt)
      : NaN;
    const lastProcessedCandidateMessageAt = state.lastProcessedCandidateMessageAt
      ? Date.parse(state.lastProcessedCandidateMessageAt)
      : NaN;

    return {
      collectedFields,
      recalledJobIds,
      hardConstraints: [],
      presentedStores: (state.presentedJobs ?? []).map((job) => ({ jobId: job.jobId })),
      storePresentationRounds: state.storePresentationRounds ?? 0,
      invitedGroups: state.invitedGroups ?? [],
      stage: null,
      terminal: state.terminal ?? undefined,
      lastCandidateMessageAt: Number.isFinite(lastCandidateMessageAt)
        ? lastCandidateMessageAt
        : undefined,
      lastProcessedCandidateMessageAt: Number.isFinite(lastProcessedCandidateMessageAt)
        ? lastProcessedCandidateMessageAt
        : undefined,
    };
  }

  private projectCollectedFieldsFromSessionFacts(
    facts: SessionFacts | null | undefined,
    now: number,
  ): ReengagementSessionState['collectedFields'] {
    if (!facts) return {};
    const collectedFields: ReengagementSessionState['collectedFields'] = {};
    for (const key of ['name', 'phone', 'age', 'gender'] as const) {
      const fact = facts.interview_info[key];
      const value = unwrapSessionFactValue(fact);
      if (!hasMeaningfulValue(value)) continue;
      const extractedAt =
        isSessionFactValue(fact) && fact.extractedAt ? Date.parse(fact.extractedAt) : NaN;
      collectedFields[key] = {
        value: String(value),
        producer: isSessionFactValue(fact) ? fact.source : 'archive',
        evidence: isSessionFactValue(fact) ? fact.evidence : undefined,
        at: Number.isFinite(extractedAt) ? extractedAt : now,
      } satisfies CollectedField;
    }
    return collectedFields;
  }

  /**
   * 写入端上限：本轮 fetchedJobs 可累积到同工具限次 3 × 单页 20 = 60 条，
   * 全量落 Redis 但只有前 10 条会被渲染（memory.section MAX_POOL_LINES），
   * 其余仅充当 jobId provenance/品牌回指匹配。截尾保序（渲染取 slice(0,10)，
   * cap 对渲染结果零影响），只裁掉极端多查询轮次里几乎不可能被回指的尾部。
   */
  async saveInvitedGroup(
    corpId: string,
    userId: string,
    sessionId: string,
    record: InvitedGroupRecord,
  ): Promise<void> {
    const state = await this.getSessionState(corpId, userId, sessionId);
    const validated = InvitedGroupRecordSchema.parse(record) as InvitedGroupRecord;
    const existing = state.invitedGroups ?? [];
    // 按群名去重；新记录在前，超上限裁最旧（该数组会全量渲染进 prompt 的
    // "已邀入群"段，正常会话个位数，cap 只是防单调增长的安全阀）。
    const MAX_INVITED_GROUPS = 20;
    const merged = [validated, ...existing]
      .filter((g, i, arr) => arr.findIndex((item) => item.groupName === g.groupName) === i)
      .slice(0, MAX_INVITED_GROUPS);

    await this.patchSessionState(corpId, userId, sessionId, { invitedGroups: merged });
  }

  /**
   * 持久化会话终态（复聊 shouldStop 的权威停发信号）。
   * 幂等覆盖写：新终态直接覆盖旧值（如 booked → handed_off）。
   */
  async saveTerminalState(
    corpId: string,
    userId: string,
    sessionId: string,
    terminal: ReengagementSessionState['terminal'],
  ): Promise<void> {
    await this.patchSessionState(corpId, userId, sessionId, { terminal: terminal ?? null });
    this.logger.log(
      `[saveTerminalState] terminal=${terminal ?? '-'} corpId=${corpId} userId=${userId} sessionId=${sessionId}`,
    );
  }

  /**
   * 记录候选人入站活动时间（复聊 shouldStop 的「锚点后已回话」停发信号）。
   * 每个入站轮调用一次；主动复聊轮不得调用（占位 user 文本不是候选人活动）。
   */
  async recordCandidateActivity(
    corpId: string,
    userId: string,
    sessionId: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.patchSessionState(corpId, userId, sessionId, {
      lastCandidateMessageAt: at.toISOString(),
    });
  }

  /**
   * 推进「候选人消息已被成功处理」时间水位（复聊停止判定的第二信号）。
   * 由 reply-workflow 在回合成功收尾（正常投递或有意沉默）时按本轮消费的候选人消息
   * 最大时间戳调用；timeout 静默丢弃的消息不会推进水位，复聊据此识别无人搭理的回话。
   */
  async recordCandidateMessagesProcessed(
    corpId: string,
    userId: string,
    sessionId: string,
    at: Date,
  ): Promise<void> {
    await this.patchSessionState(corpId, userId, sessionId, {
      lastProcessedCandidateMessageAt: at.toISOString(),
    });
  }

  // ==================== extraction ====================

  async extractAndSave(
    corpId: string,
    userId: string,
    sessionId: string,
    messages: { role: string; content: string }[],
    turnHints: TurnHints | null = null,
    preparedLaborFormIntent?: LaborFormIntentDecision,
  ): Promise<{ llmDegraded: boolean; brandIntents: BrandResolution[] }> {
    const dialogueMessages = messages.filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        message.content.trim().length > 0,
    );
    if (dialogueMessages.length === 0) return { llmDegraded: false, brandIntents: [] };

    const scopedMessages = this.trimToCurrentSessionSegment(dialogueMessages);
    const rendered = scopedMessages.map(
      (message) => `${message.role === 'user' ? '用户' : '助手'}: ${message.content}`,
    );
    const currentMessage = rendered.at(-1) ?? '';
    const history = rendered.slice(0, -1);
    const userMessages = scopedMessages
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    const lastUserText = stripTimeContext(userMessages.at(-1) ?? '').trim();
    const laborFormDecision = preparedLaborFormIntent ?? decideLaborFormIntent(lastUserText);
    const previousFacts = await this.getFacts(corpId, userId, sessionId);

    const brandData = await this.sponge.fetchBrandList();
    const aliasHints = detectBrandAliasHints(userMessages, brandData);
    const prompt = buildSessionExtractionPrompt(
      brandData,
      currentMessage,
      previousFacts ? history.slice(-this.config.sessionExtractionIncrementalMessages) : history,
      aliasHints,
      formatCurrentTime(),
      previousFacts,
    );
    const llmOutcome = await this.callLLM(prompt);

    const preferences = toSessionFacts(llmOutcome.facts, {
      confidence: 'medium',
      source: 'model',
      evidence: 'LLM 软事实提取',
      extractedAt: new Date().toISOString(),
    }).preferences as SessionFacts['preferences'];
    // labor_form 只有一个语义写入口：正常提取时由 labor_form_intent 决定，
    // 提取降级或标签无效时才使用当前消息的确定性规则兜底。模型的 legacy
    // preferences.labor_form 和 turnHints 都不能绕过这个裁决入口。
    preferences.labor_form = null;

    // 规则轨也只是软事实来源；身份 claim 在这里被刻意忽略。labor_form 由下方
    // 单独裁决，避免正常 LLM 结果又被规则轨覆盖。
    for (const fact of resolveTurnHints(turnHints)) {
      const [group, field] = fact.field.split('.');
      if (group !== 'preferences' || field === 'labor_form' || !(field in preferences)) continue;
      const target = preferences as unknown as Record<string, unknown>;
      const value =
        field === 'city' && typeof fact.value === 'string'
          ? normalizeCityName(fact.value)
          : fact.value;
      if (!hasMeaningfulValue(value)) continue;
      target[field] = sessionFactValue(value, {
        confidence: 'medium',
        source: fact.producer,
        evidence: truncateEvidence(fact.evidence.code ?? fact.evidence.label),
        extractedAt: fact.assertedAt,
      });
    }

    // LLM 显式空数组/空串代表清空；null 仍表示本轮缺席，不改变旧值。
    const llmPrefs = llmOutcome.facts.preferences as unknown as Record<string, unknown>;
    const preferenceTarget = preferences as unknown as Record<string, unknown>;
    for (const [field, value] of Object.entries(llmPrefs)) {
      if (field === 'labor_form') continue;
      if (
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'string' && !value.trim())
      ) {
        preferenceTarget[field] = this.preferenceTombstone('候选人显式清空偏好');
      }
    }

    // 规则轨 clear 是最可靠的显式清空信号。
    for (const claim of turnHints?.claims ?? []) {
      if (claim.operation !== 'clear' || !claim.field.startsWith('preferences.')) continue;
      const field = claim.field.slice('preferences.'.length);
      if (field === 'labor_form') continue;
      if (field in preferences) {
        preferenceTarget[field] = this.preferenceTombstone(
          truncateEvidence(claim.evidence.code ?? claim.evidence.label),
        );
      }
    }

    const currentTurnUserTexts: string[] = [];
    for (let index = scopedMessages.length - 1; index >= 0; index--) {
      if (scopedMessages[index].role !== 'user') break;
      currentTurnUserTexts.unshift(scopedMessages[index].content);
    }
    const geoClear = currentTurnUserTexts
      .map((text) => decideGeoPreferenceClear(stripTimeContext(text).trim()))
      .reduce(
        (result, decision) => ({
          district: result.district || decision.district,
          location: result.location || decision.location,
        }),
        { district: false, location: false },
      );
    if (geoClear.district) {
      preferences.district = this.preferenceTombstone('候选人明确表示区域不限');
    }
    if (geoClear.location) {
      preferences.location = this.preferenceTombstone('候选人明确表示地点不限');
    }
    this.applyLaborFormIntent(preferences, llmOutcome, laborFormDecision);

    // city 的所有写方共用同一个裁决器。
    const incomingCity = preferences.city;
    if (isSessionFactValue(incomingCity) && typeof incomingCity.value === 'string') {
      const adjudication = adjudicateCityClaims(
        cityClaimFromFact(previousFacts?.preferences.city ?? null),
        cityClaimFromFact(incomingCity),
      );
      if (adjudication.decision !== 'adopt') preferences.city = null;
    }

    await this.savePreferences(corpId, userId, sessionId, preferences);

    const brandOutcome = produceValidatedBrandIntents(
      llmOutcome.brandIntents,
      brandData,
      scopedMessages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content),
    );
    for (const rejected of brandOutcome.rejected) {
      this.logger.warn(
        `[extractFacts] 品牌意图被拒绝: reason=${rejected.reason}, brand=${rejected.brand ?? '<empty>'}`,
      );
    }
    return { llmDegraded: llmOutcome.degraded, brandIntents: brandOutcome.accepted };
  }

  private preferenceTombstone(evidence: string): SessionFactValue<null> {
    return sessionFactValue(null, {
      confidence: 'medium',
      source: 'candidate_quote',
      evidence: truncateEvidence(evidence),
      extractedAt: new Date().toISOString(),
    });
  }

  private applyLaborFormIntent(
    preferences: SessionFacts['preferences'],
    llmOutcome: {
      laborFormIntent: LaborFormIntentExtraction | null;
      degraded: boolean;
    },
    fallback: LaborFormIntentDecision,
  ): void {
    const extracted = llmOutcome.laborFormIntent;
    const validExtractedIntent =
      !llmOutcome.degraded &&
      extracted != null &&
      (extracted.intent !== 'set' || extracted.labor_form != null);

    if (validExtractedIntent) {
      if (extracted.intent === 'set' && extracted.labor_form) {
        preferences.labor_form = sessionFactValue(extracted.labor_form, {
          confidence: 'medium',
          source: 'model',
          evidence: truncateEvidence(extracted.quote || 'LLM 用工形式意图提取'),
          extractedAt: new Date().toISOString(),
        });
      } else if (extracted.intent === 'clear') {
        preferences.labor_form = this.preferenceTombstone(
          extracted.quote || '候选人明确撤销用工形式偏好',
        );
      }
      return;
    }

    if (fallback.kind === 'set') {
      preferences.labor_form = sessionFactValue(fallback.value, {
        confidence: 'medium',
        source: 'rule',
        evidence: '用工形式明确表达规则兜底',
        extractedAt: new Date().toISOString(),
      });
    } else if (fallback.kind === 'clear') {
      preferences.labor_form = this.preferenceTombstone('候选人明确撤销用工形式偏好');
    }
  }

  private async callLLM(prompt: string): Promise<{
    facts: EntityExtractionResult;
    brandIntents: BrandIntentEntry[];
    laborFormIntent: LaborFormIntentExtraction | null;
    degraded: boolean;
  }> {
    try {
      const result = await this.llm.generateStructured({
        role: ModelRole.Extract,
        modelId: await this.systemConfig.getExtractModelOverride(),
        schema: LLMEntityExtractionResultSchema,
        outputName: 'WeworkCandidatePreferences',
        system: SESSION_EXTRACTION_SYSTEM_PROMPT,
        prompt,
      });
      const raw = result.output;
      const brandIntents =
        z
          .array(BrandIntentEntrySchema)
          .nullable()
          .optional()
          .parse(raw.brand_intents ?? null) ?? [];
      const laborFormIntent =
        LaborFormIntentExtractionSchema.nullable()
          .optional()
          .parse(raw.labor_form_intent ?? null) ?? null;
      const facts = EntityExtractionResultSchema.parse({
        ...FALLBACK_EXTRACTION,
        preferences: raw.preferences,
        reasoning: raw.reasoning,
      });
      return { facts, brandIntents, laborFormIntent, degraded: false };
    } catch (error) {
      this.logger.warn('[extractFacts] preference extraction failed, using empty delta', error);
      return {
        facts: FALLBACK_EXTRACTION,
        brandIntents: [],
        laborFormIntent: null,
        degraded: true,
      };
    }
  }

  /**
   * 把对话裁剪到"当前会话段"：从最后一条消息往回扫，相邻消息时间差 ≥ consolidationGap
   * 即视为旧会话边界并截断（与 ConsolidationService 的断层语义一致）。
   *
   * 时间戳从消息内容的 `[消息发送时间：…]` 后缀解析（短期记忆注入，见
   * MessageParser.injectTimeContext）；无法解析的消息保守视为同一会话。
   */
  private trimToCurrentSessionSegment<T extends { content: string }>(messages: T[]): T[] {
    const gapMs = this.config.consolidationGapSeconds * 1000;
    let laterTs: number | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const ts = this.parseMessageSentAt(messages[i].content);
      if (ts === null) continue;
      if (laterTs !== null && laterTs - ts >= gapMs) {
        return messages.slice(i + 1);
      }
      laterTs = ts;
    }
    return messages;
  }

  /** 解析 `[消息发送时间：12:11 星期三]` 后缀（北京时间）为毫秒时间戳。 */
  private parseMessageSentAt(content: string): number | null {
    return parseTimeContextAt(content);
  }

  /** 旧版单 blob key（只读 + 迁移删除，禁止新写入）。 */
  private buildKey(corpId: string, userId: string, sessionId: string): string {
    return `facts:${corpId}:${userId}:${sessionId}`;
  }

  private serializeStateContent(content: Partial<WeworkSessionState>): Partial<WeworkSessionState> {
    return SessionFactsRedisContentSchema.parse(content) as Partial<WeworkSessionState>;
  }
}
