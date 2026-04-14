import { Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from './supabase.service';

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
 */
export abstract class BaseRepository {
  protected readonly logger: Logger;
  private readonly maxReadAttempts = 2;

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

  // ==================== 通用 CRUD 操作 ====================

  /**
   * 通用 SELECT 查询
   * @param columns 要查询的列（默认 '*'）
   * @param modifier 查询修饰回调（过滤、排序、分页等）
   */
  protected async select<T>(columns: string = '*', modifier?: QueryModifier): Promise<T[]> {
    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} 查询`);
      return [];
    }

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        let query = this.getClient().from(this.tableName).select(columns);
        if (modifier) query = modifier(query);

        const { data, error } = await query;
        if (error) {
          if (this.shouldRetryReadError('SELECT', error, attempt)) {
            continue;
          }
          this.handleError('SELECT', error);
          return [];
        }

        return (data as T[]) ?? [];
      } catch (error) {
        if (this.shouldRetryReadError('SELECT', error, attempt)) {
          continue;
        }
        this.handleError('SELECT', error);
        return [];
      }
    }

    return [];
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

    try {
      const returnData = options?.returnData !== false;
      const query = this.getClient()
        .from(this.tableName)
        .insert(data as Record<string, unknown>);

      const { data: result, error } = returnData ? await query.select() : await query;

      if (error) {
        if (this.isConflictError(error)) {
          this.logger.debug(`${this.tableName} 记录已存在，跳过插入`);
          return null;
        }
        this.handleError('INSERT', error);
        return null;
      }

      return returnData ? ((result as T[])?.[0] ?? null) : null;
    } catch (error) {
      if (this.isConflictError(error)) {
        this.logger.debug(`${this.tableName} 记录已存在，跳过插入`);
        return null;
      }
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

    try {
      const { error } = await this.getClient()
        .from(this.tableName)
        .insert(data as Record<string, unknown>[]);

      if (error) {
        if (this.isConflictError(error)) {
          this.logger.debug(`${this.tableName} 批量插入部分记录已存在`);
          return data.length;
        }
        this.handleError('INSERT_BATCH', error);
        return 0;
      }

      return data.length;
    } catch (error) {
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

    try {
      let query = this.getClient()
        .from(this.tableName)
        .update(data as Record<string, unknown>);
      query = modifier(query);

      const { data: result, error } = await query.select();
      if (error) {
        this.handleError('UPDATE', error);
        return [];
      }

      return (result as T[]) ?? [];
    } catch (error) {
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
        this.handleError('UPSERT', error);
        return null;
      }

      return returnData ? ((result as T[])?.[0] ?? null) : null;
    } catch (error) {
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

    try {
      const upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      if (options?.onConflict) upsertOpts.onConflict = options.onConflict;
      if (options?.ignoreDuplicates) upsertOpts.ignoreDuplicates = true;

      const { error } = await this.getClient()
        .from(this.tableName)
        .upsert(data as Record<string, unknown>[], upsertOpts);

      if (error) {
        this.handleError('UPSERT_BATCH', error);
        return 0;
      }

      return data.length;
    } catch (error) {
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

    try {
      const base = modifier(this.getClient().from(this.tableName).delete());

      if (returnDeleted) {
        const { data, error } = await base.select();
        if (error) {
          this.handleError('DELETE', error);
          return [];
        }
        return (data as T[]) ?? [];
      }

      const { error } = await base;
      if (error) {
        this.handleError('DELETE', error);
        return [];
      }
      return [];
    } catch (error) {
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

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        const { data, error } = await this.getClient().rpc(functionName, params);

        if (error) {
          if (this.isNotFoundError(error)) {
            this.logger.warn(`RPC 函数 ${functionName} 不存在，请检查数据库迁移`);
            return null;
          }
          if (this.shouldRetryReadError(`RPC:${functionName}`, error, attempt)) {
            continue;
          }
          this.handleError(`RPC:${functionName}`, error);
          return null;
        }

        return data as T;
      } catch (error) {
        if (this.shouldRetryReadError(`RPC:${functionName}`, error, attempt)) {
          continue;
        }
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

    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      try {
        let query = this.getClient()
          .from(this.tableName)
          .select('*', { count: 'exact', head: true });
        if (modifier) query = modifier(query);

        const { count, error } = await query;
        if (error) {
          if (this.shouldRetryReadError('COUNT', error, attempt)) {
            continue;
          }
          this.handleError('COUNT', error);
          return 0;
        }

        return count ?? 0;
      } catch (error) {
        if (this.shouldRetryReadError('COUNT', error, attempt)) {
          continue;
        }
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
    this.logger.error(
      `[${this.tableName}] ${operation} 失败 (${pgError.code || 'unknown'}): ${pgError.message || String(error)}`,
    );
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

  private shouldRetryReadError(operation: string, error: unknown, attempt: number): boolean {
    if (attempt >= this.maxReadAttempts || !this.isTransientReadError(error)) {
      return false;
    }

    this.logger.warn(
      `[${this.tableName}] ${operation} 命中瞬时网关异常，准备重试 (${attempt}/${this.maxReadAttempts})`,
    );
    return true;
  }

  private isTransientReadError(error: unknown): boolean {
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
