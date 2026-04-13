import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

/**
 * Supabase 基础服务
 *
 * 职责：提供 SupabaseClient 给 Repository 层使用
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);

  // Supabase 客户端
  private supabaseClient: SupabaseClient;

  // 配置
  private isInitialized = false;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {
    this.initClient();
  }

  async onModuleInit() {
    this.logger.log('✅ Supabase 基础服务初始化完成');
  }

  /**
   * 初始化 Supabase 客户端（使用官方 SDK）
   */
  private initClient(): void {
    const supabaseUrl = this.configService.get<string>('NEXT_PUBLIC_SUPABASE_URL', '');
    const supabaseKey =
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') ||
      this.configService.get<string>('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');

    if (!supabaseUrl || !supabaseKey) {
      this.logger.warn('⚠️ Supabase 配置缺失，系统配置持久化功能将使用内存模式');
      return;
    }

    this.supabaseClient = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: {
        fetch: (url: RequestInfo | URL, init?: RequestInit) => {
          // 保持 120s 超时（与原 Axios 配置一致）
          if (init?.signal) return fetch(url, init);
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 120000);
          return fetch(url, { ...init, signal: controller.signal }).finally(() =>
            clearTimeout(timeoutId),
          );
        },
      },
    });

    this.isInitialized = true;
    this.logger.log('✅ Supabase 数据库客户端已初始化');
  }

  // ==================== 公共接口（供 Repository 使用） ====================

  /**
   * 获取 Supabase 客户端
   */
  getSupabaseClient(): SupabaseClient | null {
    return this.isInitialized ? this.supabaseClient : null;
  }

  /**
   * 检查客户端是否已初始化
   */
  isClientInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * 检查是否可用（isClientInitialized 的别名）
   */
  isAvailable(): boolean {
    return this.isInitialized;
  }

  /**
   * Keep-alive：每天凌晨 3 点执行一次轻量查询，防止 Supabase 免费版数据库因闲置自动暂停
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async keepAlive(): Promise<void> {
    if (!this.isInitialized) return;
    try {
      await this.supabaseClient.from('strategy_config').select('id').limit(1);
      this.logger.debug('Supabase keep-alive ping 成功');
    } catch (error) {
      this.logger.warn('Supabase keep-alive ping 失败');
      this.exceptionNotifier?.notifyAsync({
        source: 'cron:supabase-keepalive',
        errorType: 'cron_job_failed',
        title: 'Supabase keep-alive 失败',
        error,
        level: AlertLevel.WARNING,
      });
    }
  }
}
