import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Environment } from '@enums/environment.enum';
import { RedisService } from '@infra/redis/redis.service';
import { toErrorMessage } from '@infra/utils/error.util';
import { formatLocalDateTime } from '@infra/utils/date.util';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { PhoneSessionIndexService } from '@memory/phone-session-index.service';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { SpongeService } from '@sponge/sponge.service';
import {
  ACTIVE_INTERVIEW_WORK_ORDER_STATUSES,
  type SignupWorkOrderItem,
} from '@sponge/sponge.types';
import { isStorableCandidatePhone } from '@resolution/candidate/phone';
import { normalizeSignupSource } from '@tools/booking/booking-snapshot.util';
import { OobReconcileService } from './oob-reconcile.service';

/** system_config 运行时开关键；默认关。 */
export const OOB_RECONCILE_SCAN_CONFIG_KEY = 'oob_reconcile_scan_config';

export interface OobReconcileScanRuntimeConfig {
  enabled: boolean;
  /** 单轮最多处理的带外工单行数（跨账号累计）。 */
  maxRowsPerRun?: number;
  /** 每个账号最多翻页数。 */
  maxPagesPerAccount?: number;
}

export interface OobReconcileScanSummary {
  status: 'done' | 'skipped';
  reason?: string;
  accounts: number;
  rows: number;
  supplierRows: number;
  resolved: number;
  unresolved: number;
  botMismatch: number;
  reconciled: number;
  scheduled: number;
  accountFailures: number;
  /** 单轮硬时间窗到点，剩余行/账号未处理（下一轮从头再扫，锚点标记保证不重排）。 */
  truncated: boolean;
}

const LOCK_KEY = 'oob:reconcile-scan:lock:v1';
const RUN_DEADLINE_MS = 20 * 60 * 1000;
/** 锁 TTL 必须 ≥ 2 × 单轮硬时间窗：一轮跑满 + 释放失败也不会让下一副本提前进场重排。 */
const LOCK_TTL_SECONDS = (2 * RUN_DEADLINE_MS) / 1000;
const RELEASE_OWNED_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";
const SIGNUP_LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES_PER_ACCOUNT = 10;
const DEFAULT_MAX_ROWS_PER_RUN = 500;
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * 带外工单补偿扫描（每 6 小时）：候选人不再说话时没有回合可对账，按已配 token 的托管账号
 * 调 signup/self/list/v2（报名近 15 天、状态在途、翻页有上限），筛 signupSource=SUPPLIER，
 * 按手机号反查会话（手机号→会话索引），命中的走与回合相同的对账副作用；反查不到的落观测不处理。
 *
 * 护栏：整轮 Redis 互斥、单轮条数上限、单次超时、指数退避、只在生产 NODE_ENV 执行、
 * 运行时开关默认关。任何账号失败只记数不中断整轮。
 */
@Injectable()
export class OobReconcileScanCronService {
  private readonly logger = new Logger(OobReconcileScanCronService.name);

  constructor(
    private readonly hostingMemberConfig: HostingMemberConfigService,
    private readonly spongeService: SpongeService,
    private readonly phoneSessionIndex: PhoneSessionIndexService,
    private readonly oobReconcile: OobReconcileService,
    private readonly redisService: RedisService,
    private readonly systemConfig: SystemConfigService,
    private readonly configService: ConfigService,
    @Optional() private readonly tracer?: AgentTracerService,
  ) {}

  @Cron('17 */6 * * *', { timeZone: 'Asia/Shanghai' })
  async scan(): Promise<void> {
    if (this.configService.get<string>('READ_ONLY_PREVIEW', 'false') === 'true') return;
    if (
      this.configService.get<Environment>('NODE_ENV', Environment.Development) !==
      Environment.Production
    ) {
      return;
    }
    const runtime = await this.getRuntimeConfig();
    if (!runtime.enabled) return;

    const token = await this.acquireLock();
    if (!token) {
      this.logger.log('[oob-scan] 另一副本正在扫描，跳过本轮');
      return;
    }
    try {
      await this.runOnce(runtime);
    } catch (error) {
      this.logger.error(`[oob-scan] 扫描失败: ${toErrorMessage(error)}`);
      this.emit({ type: 'oob_reconcile_scan', status: 'failed', reason: toErrorMessage(error) });
    } finally {
      await this.releaseLock(token);
    }
  }

  /** 执行一轮（独立方法便于测试 / 手动触发；不含锁与环境闸）。 */
  async runOnce(
    runtime: OobReconcileScanRuntimeConfig = { enabled: true },
    now: number = Date.now(),
  ): Promise<OobReconcileScanSummary> {
    const startedAt = Date.now();
    const summary: OobReconcileScanSummary = {
      status: 'done',
      accounts: 0,
      rows: 0,
      supplierRows: 0,
      resolved: 0,
      unresolved: 0,
      botMismatch: 0,
      reconciled: 0,
      scheduled: 0,
      accountFailures: 0,
      truncated: false,
    };
    const maxRows = runtime.maxRowsPerRun ?? DEFAULT_MAX_ROWS_PER_RUN;
    const maxPages = runtime.maxPagesPerAccount ?? DEFAULT_MAX_PAGES_PER_ACCOUNT;
    const botImIds = await this.hostingMemberConfig.listTokenConfiguredBotImIds();
    summary.accounts = botImIds.length;
    if (botImIds.length === 0) {
      summary.status = 'skipped';
      summary.reason = 'no_token_configured_accounts';
      this.emit({ type: 'oob_reconcile_scan', ...summary, durationMs: Date.now() - startedAt });
      return summary;
    }

    const signUpStartTime = formatLocalDateTime(new Date(now - SIGNUP_LOOKBACK_MS));
    // 同一手机号在多个账号/多张工单里重复出现时只对账一次（对账内部按快照全量处理）。
    const seen = new Set<string>();

    for (const botImId of botImIds) {
      if (summary.rows >= maxRows || summary.truncated) break;
      if (this.isPastDeadline(startedAt)) {
        summary.truncated = true;
        break;
      }
      let rows: { total: number; supplier: SignupWorkOrderItem[] };
      try {
        rows = await this.fetchSupplierRows(
          botImId,
          signUpStartTime,
          maxPages,
          maxRows - summary.rows,
        );
      } catch (error) {
        summary.accountFailures += 1;
        this.logger.warn(`[oob-scan] 账号 ${botImId} 拉取失败: ${toErrorMessage(error)}`);
        continue;
      }
      summary.rows += rows.total;
      for (const row of rows.supplier) {
        // 硬时间窗按行检查：对账含海绵查询与排任务，账号级检查不够细，一个大账号能把整轮拖过锁 TTL。
        if (this.isPastDeadline(startedAt)) {
          summary.truncated = true;
          break;
        }
        summary.supplierRows += 1;
        const phone = typeof row.phone === 'string' ? row.phone.trim() : '';
        if (!isStorableCandidatePhone(phone)) {
          summary.unresolved += 1;
          continue;
        }
        const seenKey = `${botImId}:${phone}`;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);

        const record = await this.phoneSessionIndex.lookupByPhone(phone);
        if (!record) {
          summary.unresolved += 1;
          continue;
        }
        // 账号边界：索引记录的是候选人在哪个托管账号下的会话；工单属于别的账号时不能
        // 用本账号 token 往那条会话排提醒/改终态。
        if (record.botImId && record.botImId !== botImId) {
          summary.botMismatch += 1;
          continue;
        }
        summary.resolved += 1;
        try {
          const result = await this.oobReconcile.reconcile({
            corpId: record.corpId,
            userId: record.userId,
            chatId: record.chatId,
            botImId,
            phone,
            trigger: 'scan',
          });
          if (result.status === 'done') {
            summary.reconciled += 1;
            summary.scheduled += result.scheduled;
          }
        } catch (error) {
          this.logger.warn(
            `[oob-scan] 对账失败 chatId=${record.chatId} workOrderId=${row.workOrderId}: ${toErrorMessage(error)}`,
          );
        }
      }
    }

    if (summary.truncated) {
      this.logger.warn(
        `[oob-scan] 单轮硬时间窗 ${RUN_DEADLINE_MS / 60000} 分钟到点，剩余行留待下一轮`,
      );
    }
    this.logger.log(
      `[oob-scan] 完成: accounts=${summary.accounts} rows=${summary.rows} supplier=${summary.supplierRows} resolved=${summary.resolved} unresolved=${summary.unresolved} botMismatch=${summary.botMismatch} reconciled=${summary.reconciled} scheduled=${summary.scheduled} accountFailures=${summary.accountFailures} truncated=${summary.truncated}`,
    );
    this.emit({ type: 'oob_reconcile_scan', ...summary, durationMs: Date.now() - startedAt });
    return summary;
  }

  private async fetchSupplierRows(
    botImId: string,
    signUpStartTime: string,
    maxPages: number,
    rowBudget: number,
  ): Promise<{ total: number; supplier: SignupWorkOrderItem[] }> {
    const supplier: SignupWorkOrderItem[] = [];
    let total = 0;
    for (let pageNum = 1; pageNum <= maxPages && total < rowBudget; pageNum += 1) {
      const page = await this.withRetry(() =>
        this.spongeService.fetchSelfSignupWorkOrdersV2(
          {
            pageNum,
            pageSize: PAGE_SIZE,
            queryParam: {
              signUpStartTime,
              currentStatus: Array.from(ACTIVE_INTERVIEW_WORK_ORDER_STATUSES),
            },
          },
          { botImId },
          { timeoutMs: FETCH_TIMEOUT_MS },
        ),
      );
      const rows = page.workOrders ?? [];
      total += rows.length;
      for (const row of rows) {
        if (normalizeSignupSource(row.signupSource) === 'SUPPLIER') supplier.push(row);
      }
      if (rows.length < PAGE_SIZE || total >= page.total) break;
    }
    return { total, supplier };
  }

  private isPastDeadline(startedAt: number): boolean {
    return Date.now() - startedAt > RUN_DEADLINE_MS;
  }

  /** 指数退避重试（1s、2s），最后一次失败向上抛给账号级计数。 */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < FETCH_ATTEMPTS) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError;
  }

  private async getRuntimeConfig(): Promise<OobReconcileScanRuntimeConfig> {
    try {
      const stored = await this.systemConfig.getConfigValue<Partial<OobReconcileScanRuntimeConfig>>(
        OOB_RECONCILE_SCAN_CONFIG_KEY,
      );
      return {
        enabled: stored?.enabled === true,
        maxRowsPerRun: positiveInt(stored?.maxRowsPerRun),
        maxPagesPerAccount: positiveInt(stored?.maxPagesPerAccount),
      };
    } catch (error) {
      this.logger.warn(`[oob-scan] 读取运行时开关失败，按关闭处理: ${toErrorMessage(error)}`);
      return { enabled: false };
    }
  }

  private async acquireLock(): Promise<string | null> {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    try {
      const acquired = await this.redisService.setNx(LOCK_KEY, token, LOCK_TTL_SECONDS);
      return acquired ? token : null;
    } catch (error) {
      // 锁不可用时宁可不跑：扫描不是关键路径，重复跑却会给同一候选人排两遍提醒。
      this.logger.warn(`[oob-scan] 获取扫描锁失败，本轮跳过: ${toErrorMessage(error)}`);
      return null;
    }
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redisService.eval(RELEASE_OWNED_LOCK_SCRIPT, [LOCK_KEY], [token]);
    } catch (error) {
      this.logger.warn(`[oob-scan] 释放扫描锁失败（到期自动过期）: ${toErrorMessage(error)}`);
    }
  }

  private emit(event: Parameters<AgentTracerService['emit']>[0]): void {
    this.tracer?.emit(event);
  }
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
