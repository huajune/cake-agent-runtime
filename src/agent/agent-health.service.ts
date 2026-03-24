import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { RouterService } from '@providers/router.service';
import { RegistryService } from '@providers/registry.service';
import { ContextService } from './context/context.service';

export interface DependencyCheck {
  ok: boolean;
  error?: string;
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  providers: string[];
  roles: Record<string, unknown>;
  scenarios: string[];
  tools: {
    builtIn: string[];
    mcp: string[];
    total: number;
  };
  checks: {
    redis: boolean;
    supabase: boolean;
  };
}

@Injectable()
export class AgentHealthService {
  private readonly logger = new Logger(AgentHealthService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly supabaseService: SupabaseService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly router: RouterService,
    private readonly registry: RegistryService,
    private readonly context: ContextService,
  ) {}

  async check(): Promise<HealthCheckResult> {
    const builtInTools = this.toolRegistry.listBySource('built-in');
    const mcpTools = this.toolRegistry.listBySource('mcp');

    const [redis, supabase] = await Promise.all([this.checkRedis(), this.checkSupabase()]);

    let status: 'healthy' | 'degraded' | 'unhealthy';
    let message: string;

    if (!redis.ok) {
      status = 'unhealthy';
      message = `Redis 不可用: ${redis.error}`;
    } else if (!supabase.ok) {
      status = 'degraded';
      message = `Supabase 不可用: ${supabase.error}`;
    } else {
      status = 'healthy';
      message = 'Agent 服务正常';
    }

    return {
      status,
      message,
      providers: this.registry.listProviders(),
      roles: this.router.listRoleDetails(),
      scenarios: this.context.getLoadedScenarios(),
      tools: {
        builtIn: builtInTools,
        mcp: mcpTools,
        total: builtInTools.length + mcpTools.length,
      },
      checks: {
        redis: redis.ok,
        supabase: supabase.ok,
      },
    };
  }

  private async checkRedis(): Promise<DependencyCheck> {
    try {
      const result = await this.redisService.ping();
      return { ok: result === 'PONG' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Redis 连接失败' };
    }
  }

  private async checkSupabase(): Promise<DependencyCheck> {
    try {
      if (!this.supabaseService.isAvailable()) {
        return { ok: false, error: '未初始化' };
      }
      const client = this.supabaseService.getSupabaseClient();
      if (!client) return { ok: false, error: '客户端为空' };
      // 轻量查询验证连通性
      const { error } = await client.from('strategy_config').select('id').limit(1);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Supabase 连接失败' };
    }
  }
}
