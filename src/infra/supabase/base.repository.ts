import { Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';
import { supabaseCircuitBreaker } from './supabase-circuit-breaker';

/**
 * Query modifier callback for applying filters, ordering, and pagination to Supabase queries
 * @example (q) => q.eq('status', 'active').order('created_at', { ascending: false }).limit(10)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryModifier = (query: any) => any;

/**
 * Insert 操作选项
 */
export interface InsertOptions {
  /** 是否返回插入的数据（默认 true） */
  returnData?: boolean;
}

/**
 * Upsert 操作选项
 */
export interface UpsertOptions {
  /** 冲突检测列 */
  onConflict?: string;
  /** 冲突时是否忽略（不更新） */
  ignoreDuplicates?: boolean;
  /** 是否返回数据（默认 true） */
  returnData?: boolean;
}

/**
 * Supabase Repository 基类（SDK 版本）
 *
 * 设计原则：
 * 1. 使用 @supabase/supabase-js 官方 SDK 替代手动 Axios 封装
 * 2. 通用 CRUD 操作使用 callback filter 模式实现类型安全的链式查询
 * 3. 错误处理标准化 - PostgrestError 统一处理
 * 4. 类型安全 - 泛型支持强类型操作
 *
 * 韧性（2026-06-04 事故后加固）：
 * - 瞬时网关错误（522/503/cloudflare/fetch failed…）重试时加「指数退避 + 抖动」，
 *   不再零间隔疯狂重打。
 * - 所有调用前经过「进程级共享熔断器」：任一 Repository 连续观察到瞬时故障即跳闸，
 *   冷却窗口内所有 Repository 快速失败、停止打 DB，从根上阻断重试风暴；DB 恢复后
 *   自动半开试探恢复。详见 supabase-circuit-breaker.ts。
 */
export abstract class BaseRepository {
  protected readonly logger: Logger;
  protected readonly maxReadAttempts = 2;

  /**
   * 数据库表名（子类必须实现）
   */
  protected abstract readonly tableName: string;

  constructor(protected readonly supabaseService: SupabaseService) {
    this.logger = new Logger(this.constructor.name);
  }

  // ==================== 基础设施方法 ====================

  /**
   * 获取 Supabase 客户端（带初始化检查）
   * @throws Error 如果客户端未初始化
   */
  protected getClient(): SupabaseClient {
    const client = this.supabaseService.getSupabaseClient();
    if (!client) {
      throw new Error(`Supabase 客户端未初始化，无法访问表 ${this.tableName}`);
    }
    return client;
  }

  /**
   * 检查客户端是否可用
   */
  protected isAvailable(): boolean {
    return this.supabaseService.isClientInitialized();
  }

  /**
   * 调用前的熔断检查。熔断 OPEN 期间快速跳过（不打 DB），语义上与
   * 「客户端未初始化」等同 —— 返回各方法的空值兜底，避免对濒死的 DB 继续施压。
   */
  protected circuitBlocked(operation: string): boolean {
    if (supabaseCircuitBreaker.canRequest()) {
      return false;
    }
    if (supabaseCircuitBreaker.shouldLogRejection()) {
      this.logger.warn(`[${this.tableName}] Supabase 熔断器 OPEN，快速跳过 ${operation}`);
    }
    return true;
  }

  /**
   * 根据错误类型更新熔断器：瞬时/连接类故障记失败（可能跳闸），
   * 其余（业务错误，说明 DB 可达）记成功。
   */
  private noteOutcome(error: unknown): void {
    if (this.isTransientReadError(error)) {
      supabaseCircuitBreaker.recordFailure();
    } else {
      supabaseCircuitBreaker.recordSuccess();
    }
  }

  /** 指数退避（含抖动）：150ms、300ms…，上限 1s，用于瞬时网关错误的重试间隔 */
  private getBackoffMs(attempt: number): number {
    const base = 150;
    const exp = base * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 100);
    return Math.min(exp + jitter, 1000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ==================== 通用 CRUD 操作 ====================

  /**
   * 通用 SELECT 查询
   * @param columns 要查询的列（默认 '*'）
   * @param modifier 查询修饰回调（过滤、排序、分页等）
   */
  protected async select<T>(columns: string = '*', modifier?: QueryModifier): Promise<T[]> {
    return this.selectFrom<T>(this.tableName, columns, modifier);
  }

  /**
   * 通用 SELECT 查询（可指定表名）。
   *
   * 与 {@link select} 共享同一套「熔断 + 退避重试」韧性逻辑，但允许查询非本仓储默认表
   * （如监控仓储读 user_activity）。所有跨表只读查询都应走这里，确保统一受熔断器保护，
   * 避免绕过熔断器在 DB 濒死时继续施压（2026-06-04 事故根因之一）。
   */
  protected async selectFrom<T>(
    table: string,
    columns: string = '*',
    modifier?: QueryModifier,
  ): Promise<T[]> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${table} 查询`);
      return [];
    }
    if (this.circuitBlocked(`SELECT:${table}`)) {
      return [];
    }

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        let query = this.getClient().from(table).select(columns);
        if (modifier) query = modifier(query);

        const { data, error } = await query;
        if (error) {
          if (this.shouldRetryReadError(`SELECT:${table}`, error, attempt)) {
            await this.sleep(this.getBackoffMs(attempt));
            continue;
          }
          this.noteOutcome(error);
          this.handleError(`SELECT:${table}`, error);
          return [];
        }

        supabaseCircuitBreaker.recordSuccess();
        return (data as T[]) ?? [];
      } catch (error) {
        if (this.shouldRetryReadError(`SELECT:${table}`, error, attempt)) {
          await this.sleep(this.getBackoffMs(attempt));
          continue;
        }
        this.noteOutcome(error);
        this.handleError(`SELECT:${table}`, error);
        return [];
      }
    }

    return [];
  }

  /**
   * 分页拉全量 SELECT：复用 {@link selectFrom} 的熔断 + 退避重试，按 range 翻页直到取尽，
   * 绕开 PostgREST 默认 max_rows(1000) 截断。任一页失败即停止并返回已累积结果。
   *
   * @param table 目标表名（可为非默认表）
   * @param columns 查询列
   * @param modifier 过滤/排序回调（**必须包含稳定 ORDER BY**，否则分页可能漏行/重复）
   * @param pageSize 每页行数，默认 1000
   */
  protected async selectAllPaged<T>(
    table: string,
    columns: string = '*',
    modifier?: QueryModifier,
    pageSize = 1000,
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let from = 0; ; from += pageSize) {
      const page = await this.selectFrom<T>(table, columns, (q) => {
        const base = modifier ? modifier(q) : q;
        return base.range(from, from + pageSize - 1);
      });
      rows.push(...page);
      // page 不足一页：取尽（或中途出错返回 []）→ 结束分页。
      if (page.length < pageSize) break;
    }
    return rows;
  }

  /**
   * 分页拉全量「列表型 RPC（RETURNS TABLE）」：经熔断器保护后按 range 翻页，绕开 PostgREST
   * max_rows(1000) 截断。任一页失败即停止并返回已累积结果。
   */
  protected async rpcAllPaged<T>(
    functionName: string,
    params?: Record<string, unknown>,
    pageSize = 1000,
  ): Promise<T[]> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 RPC 分页调用 ${functionName}`);
      return [];
    }
    if (this.circuitBlocked(`RPC:${functionName}`)) {
      return [];
    }

    const rows: T[] = [];
    for (let from = 0; ; from += pageSize) {
      try {
        const { data, error } = await this.getClient()
          .rpc(functionName, params)
          .range(from, from + pageSize - 1);

        if (error) {
          this.noteOutcome(error);
          this.handleError(`RPC:${functionName}`, error);
          break;
        }

        supabaseCircuitBreaker.recordSuccess();
        const page = (data as T[]) ?? [];
        rows.push(...page);
        if (page.length < pageSize) break;
      } catch (error) {
        this.noteOutcome(error);
        this.handleError(`RPC:${functionName}`, error);
        break;
      }
    }
    return rows;
  }

  /**
   * 通用 SELECT 单条记录
   * @param columns 要查询的列（默认 '*'）
   * @param modifier 查询修饰回调
   */
  protected async selectOne<T>(columns: string = '*', modifier?: QueryModifier): Promise<T | null> {
    const results = await this.select<T>(columns, (q) => {
      const base = modifier ? modifier(q) : q;
      return base.limit(1);
    });
    return results.length > 0 ? results[0] : null;
  }

  /**
   * 通用 INSERT
   * @param data 要插入的数据
   * @param options 额外配置
   */
  protected async insert<T>(data: Partial<T>, options?: InsertOptions): Promise<T | null> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} 插入`);
      return null;
    }
    if (this.circuitBlocked('INSERT')) {
      return null;
    }

    try {
      const returnData = options?.returnData !== false;
      const query = this.getClient()
        .from(this.tableName)
        .insert(data as Record<string, unknown>);

      const { data: result, error } = returnData ? await query.select() : await query;

      if (error) {
        if (this.isConflictError(error)) {
          supabaseCircuitBreaker.recordSuccess();
          this.logger.debug(`${this.tableName} 记录已存在，跳过插入`);
          return null;
        }
        this.noteOutcome(error);
        this.handleError('INSERT', error);
        return null;
      }

      supabaseCircuitBreaker.recordSuccess();
      return returnData ? ((result as T[])?.[0] ?? null) : null;
    } catch (error) {
      if (this.isConflictError(error)) {
        supabaseCircuitBreaker.recordSuccess();
        this.logger.debug(`${this.tableName} 记录已存在，跳过插入`);
        return null;
      }
      this.noteOutcome(error);
      this.handleError('INSERT', error);
      return null;
    }
  }

  /**
   * 通用批量 INSERT
   * @param data 要插入的数据数组
   */
  protected async insertBatch<T>(data: Partial<T>[]): Promise<number> {
    if (!this.isAvailable() || data.length === 0) {
      return 0;
    }
    if (this.circuitBlocked('INSERT_BATCH')) {
      return 0;
    }

    try {
      const { error } = await this.getClient()
        .from(this.tableName)
        .insert(data as Record<string, unknown>[]);

      if (error) {
        if (this.isConflictError(error)) {
          supabaseCircuitBreaker.recordSuccess();
          this.logger.debug(`${this.tableName} 批量插入部分记录已存在`);
          return data.length;
        }
        this.noteOutcome(error);
        this.handleError('INSERT_BATCH', error);
        return 0;
      }

      supabaseCircuitBreaker.recordSuccess();
      return data.length;
    } catch (error) {
      this.noteOutcome(error);
      this.handleError('INSERT_BATCH', error);
      return 0;
    }
  }

  /**
   * 通用 UPDATE（使用 modifier 指定筛选条件）
   * @param data 要更新的数据
   * @param modifier 筛选条件回调
   */
  protected async update<T>(data: Partial<T>, modifier: QueryModifier): Promise<T[]> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} 更新`);
      return [];
    }
    if (this.circuitBlocked('UPDATE')) {
      return [];
    }

    try {
      let query = this.getClient()
        .from(this.tableName)
        .update(data as Record<string, unknown>);
      query = modifier(query);

      const { data: result, error } = await query.select();
      if (error) {
        this.noteOutcome(error);
        this.handleError('UPDATE', error);
        return [];
      }

      supabaseCircuitBreaker.recordSuccess();
      return (result as T[]) ?? [];
    } catch (error) {
      this.noteOutcome(error);
      this.handleError('UPDATE', error);
      return [];
    }
  }

  /**
   * 通用 UPSERT（INSERT or UPDATE on conflict）
   * @param data 要插入/更新的数据
   * @param options upsert 配置
   */
  protected async upsert<T>(data: Partial<T>, options?: UpsertOptions): Promise<T | null> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} upsert`);
      return null;
    }
    if (this.circuitBlocked('UPSERT')) {
      return null;
    }

    try {
      const returnData = options?.returnData !== false;
      const upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      if (options?.onConflict) upsertOpts.onConflict = options.onConflict;
      if (options?.ignoreDuplicates) upsertOpts.ignoreDuplicates = true;

      const query = this.getClient()
        .from(this.tableName)
        .upsert(data as Record<string, unknown>, upsertOpts);

      const { data: result, error } = returnData ? await query.select() : await query;

      if (error) {
        this.noteOutcome(error);
        this.handleError('UPSERT', error);
        return null;
      }

      supabaseCircuitBreaker.recordSuccess();
      return returnData ? ((result as T[])?.[0] ?? null) : null;
    } catch (error) {
      this.noteOutcome(error);
      this.handleError('UPSERT', error);
      return null;
    }
  }

  /**
   * 通用批量 UPSERT
   * @param data 要插入/更新的数据数组
   * @param options upsert 配置
   */
  protected async upsertBatch<T>(data: Partial<T>[], options?: UpsertOptions): Promise<number> {
    if (!this.isAvailable() || data.length === 0) {
      return 0;
    }
    if (this.circuitBlocked('UPSERT_BATCH')) {
      return 0;
    }

    try {
      const upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      if (options?.onConflict) upsertOpts.onConflict = options.onConflict;
      if (options?.ignoreDuplicates) upsertOpts.ignoreDuplicates = true;

      const { error } = await this.getClient()
        .from(this.tableName)
        .upsert(data as Record<string, unknown>[], upsertOpts);

      if (error) {
        this.noteOutcome(error);
        this.handleError('UPSERT_BATCH', error);
        return 0;
      }

      supabaseCircuitBreaker.recordSuccess();
      return data.length;
    } catch (error) {
      this.noteOutcome(error);
      this.handleError('UPSERT_BATCH', error);
      return 0;
    }
  }

  /**
   * 通用 DELETE
   * @param modifier 筛选条件回调
   * @param returnDeleted 是否返回删除的记录
   */
  protected async delete<T = unknown>(
    modifier: QueryModifier,
    returnDeleted: boolean = false,
  ): Promise<T[]> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} 删除`);
      return [];
    }
    if (this.circuitBlocked('DELETE')) {
      return [];
    }

    try {
      const base = modifier(this.getClient().from(this.tableName).delete());

      if (returnDeleted) {
        const { data, error } = await base.select();
        if (error) {
          this.noteOutcome(error);
          this.handleError('DELETE', error);
          return [];
        }
        supabaseCircuitBreaker.recordSuccess();
        return (data as T[]) ?? [];
      }

      const { error } = await base;
      if (error) {
        this.noteOutcome(error);
        this.handleError('DELETE', error);
        return [];
      }
      supabaseCircuitBreaker.recordSuccess();
      return [];
    } catch (error) {
      this.noteOutcome(error);
      this.handleError('DELETE', error);
      return [];
    }
  }

  /**
   * 调用 RPC 函数
   * @param functionName 函数名
   * @param params 函数参数
   */
  protected async rpc<T>(
    functionName: string,
    params?: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 RPC 调用 ${functionName}`);
      return null;
    }
    if (this.circuitBlocked(`RPC:${functionName}`)) {
      return null;
    }

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        const { data, error } = await this.getClient().rpc(functionName, params);

        if (error) {
          if (this.isNotFoundError(error)) {
            supabaseCircuitBreaker.recordSuccess();
            this.logger.warn(`RPC 函数 ${functionName} 不存在，请检查数据库迁移`);
            return null;
          }
          if (this.shouldRetryReadError(`RPC:${functionName}`, error, attempt)) {
            await this.sleep(this.getBackoffMs(attempt));
            continue;
          }
          this.noteOutcome(error);
          this.handleError(`RPC:${functionName}`, error);
          return null;
        }

        supabaseCircuitBreaker.recordSuccess();
        return data as T;
      } catch (error) {
        if (this.shouldRetryReadError(`RPC:${functionName}`, error, attempt)) {
          await this.sleep(this.getBackoffMs(attempt));
          continue;
        }
        this.noteOutcome(error);
        this.handleError(`RPC:${functionName}`, error);
        return null;
      }
    }

    return null;
  }

  /**
   * 获取记录数量
   * @param modifier 筛选条件回调
   */
  protected async count(modifier?: QueryModifier): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }
    if (this.circuitBlocked('COUNT')) {
      return 0;
    }

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        let query = this.getClient()
          .from(this.tableName)
          .select('*', { count: 'exact', head: true });
        if (modifier) query = modifier(query);

        const { count, error } = await query;
        if (error) {
          if (this.shouldRetryReadError('COUNT', error, attempt)) {
            await this.sleep(this.getBackoffMs(attempt));
            continue;
          }
          this.noteOutcome(error);
          this.handleError('COUNT', error);
          return 0;
        }

        supabaseCircuitBreaker.recordSuccess();
        return count ?? 0;
      } catch (error) {
        if (this.shouldRetryReadError('COUNT', error, attempt)) {
          await this.sleep(this.getBackoffMs(attempt));
          continue;
        }
        this.noteOutcome(error);
        this.handleError('COUNT', error);
        return 0;
      }
    }

    return 0;
  }

  // ==================== RPC 结果转换 ====================

  /**
   * 将 RPC 返回的 snake_case string 字段转换为 camelCase 的 number 值
   * @param row RPC 返回的原始行（snake_case 键，string 值）
   * @param mapping 字段映射：{ camelCaseKey: { field: 'snake_case_key', type: 'int' | 'float' } }
   */
  protected mapRpcRow<T>(
    row: Record<string, unknown>,
    mapping: Record<string, { field: string; type: 'int' | 'float' | 'string' }>,
  ): T {
    const result: Record<string, unknown> = {};
    for (const [camelKey, { field, type }] of Object.entries(mapping)) {
      const raw = row[field];
      if (type === 'int') {
        result[camelKey] = parseInt((raw as string) ?? '0', 10);
      } else if (type === 'float') {
        result[camelKey] = parseFloat((raw as string) ?? '0');
      } else {
        result[camelKey] = raw ?? '';
      }
    }
    return result as T;
  }

  // ==================== 错误处理 ====================

  /**
   * 统一错误处理
   */
  protected handleError(operation: string, error: unknown): void {
    const pgError = error as { code?: string; message?: string };
    const rawMessage = pgError.message || String(error);
    const message = this.summarizeErrorMessage(rawMessage);
    this.logger.error(
      `[${this.tableName}] ${operation} 失败 (${pgError.code || 'unknown'}): ${message}`,
    );
  }

  /**
   * Supabase SDK 在非 JSON 响应（如 Cloudflare 521 错误页）下，会把整页 HTML 灌进
   * error.message。直接打 logger 会有几百行噪音，淹没真正的信号。
   * 这里把 HTML 收敛成单行摘要，提取 status code、title 等关键信号 + 截断。
   */
  private summarizeErrorMessage(message: string): string {
    const looksLikeHtml = /<!doctype\s+html|<html[\s>]/i.test(message);
    if (!looksLikeHtml) {
      return message.length > 500 ? `${message.slice(0, 500)}… [truncated]` : message;
    }

    const titleMatch = message.match(/<title[^>]*>([^<]+)<\/title>/i);
    const errorCodeMatch = message.match(/Error code (\d+)/i);
    const hostMatch = message.match(/cf-host-status[\s\S]*?<span class="md:block[^>]*>([^<]+)</i);

    const parts: string[] = ['HTML response (non-JSON)'];
    if (errorCodeMatch) parts.push(`code=${errorCodeMatch[1]}`);
    if (titleMatch) parts.push(`title="${titleMatch[1].trim()}"`);
    if (hostMatch) parts.push(`host="${hostMatch[1].trim()}"`);
    return parts.join(' | ');
  }

  /**
   * 检查是否为冲突错误（unique_violation）
   */
  protected isConflictError(error: unknown): boolean {
    return (error as { code?: string }).code === '23505';
  }

  /**
   * 检查是否为未找到错误
   */
  protected isNotFoundError(error: unknown): boolean {
    const code = (error as { code?: string }).code;
    return code === 'PGRST116' || code === '42883';
  }

  protected shouldRetryReadError(operation: string, error: unknown, attempt: number): boolean {
    if (attempt >= this.maxReadAttempts || !this.isTransientReadError(error)) {
      return false;
    }

    this.logger.warn(
      `[${this.tableName}] ${operation} 命中瞬时网关异常，准备重试 (${attempt}/${this.maxReadAttempts})`,
    );
    return true;
  }

  protected isTransientReadError(error: unknown): boolean {
    const message = ((error as { message?: string })?.message || String(error)).toLowerCase();

    return (
      message.includes('502 bad gateway') ||
      message.includes('503 service unavailable') ||
      message.includes('504 gateway timeout') ||
      message.includes('cloudflare') ||
      message.includes('fetch failed') ||
      message.includes('network error') ||
      message.includes('etimedout') ||
      message.includes('econnreset') ||
      message.includes('socket hang up')
    );
  }
}
