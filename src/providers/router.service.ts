import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelRole } from './types';

export interface ModelRoute {
  modelId: string;
  fallbacks: string[] | undefined;
}

/**
 * 模型路由服务 — Layer 3: 角色 → 模型映射
 *
 * 对标 ZeroClaw src/providers/router.rs 的 RouterProvider。
 *
 * 通过环境变量配置角色映射：
 *   AGENT_CHAT_MODEL=qwen/qwen3.6-plus
 *   AGENT_CHAT_FALLBACKS=deepseek/deepseek-chat,anthropic/claude-sonnet-4-6
 *   AGENT_EXTRACT_MODEL=openai/gpt-5-mini
 *   AGENT_VISION_MODEL=qwen/qwen3.6-plus
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  constructor(private readonly config: ConfigService) {}

  /** 列出所有已配置的角色 */
  listRoles(): ModelRole[] {
    return Object.values(ModelRole).filter((role) =>
      this.config.get<string>(`AGENT_${role.toUpperCase()}_MODEL`),
    );
  }

  /** 列出所有已配置角色的详细信息（角色 → 模型 + fallbacks） */
  listRoleDetails(): Record<string, { model: string; fallbacks?: string[] }> {
    const details: Record<string, { model: string; fallbacks?: string[] }> = {};
    for (const role of this.listRoles()) {
      const model = this.config.get<string>(`AGENT_${role.toUpperCase()}_MODEL`)!;
      const fallbacks = this.parseFallbacks(role);
      details[role] = fallbacks ? { model, fallbacks } : { model };
    }
    return details;
  }

  /** 获取指定角色的 fallback 模型列表 */
  getFallbacks(role: ModelRole | string): string[] | undefined {
    return this.parseFallbacks(role);
  }

  /** 获取指定角色当前映射到的 modelId（直接读 AGENT_{ROLE}_MODEL 环境变量）。 */
  getModelIdByRole(role: ModelRole | string): string {
    return this.config.get<string>(`AGENT_${role.toUpperCase()}_MODEL`) ?? '';
  }

  /** 获取指定角色的执行路由（primary + fallback 链）。 */
  getRouteByRole(role: ModelRole | string): ModelRoute {
    const modelId = this.getModelIdByRole(role);
    if (!modelId) {
      throw new Error(`角色 "${role}" 未配置模型 (AGENT_${role.toUpperCase()}_MODEL)`);
    }
    return {
      modelId,
      fallbacks: this.parseFallbacks(role),
    };
  }

  /**
   * 解析一次执行要用的模型路由：
   *
   * - 指定 overrideModelId 时用精确模型；否则走 role 路由
   * - 显式传入 fallbacks 时优先采用；否则使用 role 默认 fallback
   * - disableFallbacks=true 时强制清空降级链
   */
  resolveRoute(options: {
    role?: ModelRole | string;
    overrideModelId?: string;
    fallbacks?: string[];
    disableFallbacks?: boolean;
  }): ModelRoute {
    const role = options.role ?? ModelRole.Chat;
    const trimmed = options.overrideModelId?.trim();
    const configuredFallbacks = options.fallbacks ?? this.getFallbacks(role);
    const fallbacks = options.disableFallbacks ? undefined : configuredFallbacks;

    if (trimmed) {
      this.logger.log(`使用指定模型: ${trimmed}${options.disableFallbacks ? ' (禁用降级)' : ''}`);
      return {
        modelId: trimmed,
        fallbacks,
      };
    }

    const route = this.getRouteByRole(role);
    return fallbacks ? { modelId: route.modelId, fallbacks } : route;
  }

  /** 兼容 chat turn 路径的便捷别名。 */
  resolveForTurn(options: {
    overrideModelId?: string;
    fallbacks?: string[];
    disableFallbacks?: boolean;
  }): ModelRoute {
    return this.resolveRoute({
      role: ModelRole.Chat,
      overrideModelId: options.overrideModelId,
      fallbacks: options.fallbacks,
      disableFallbacks: options.disableFallbacks,
    });
  }

  private parseFallbacks(role: ModelRole | string): string[] | undefined {
    const raw =
      this.config.get<string>(`AGENT_${role.toUpperCase()}_FALLBACKS`) ||
      this.config.get<string>('AGENT_DEFAULT_FALLBACKS');
    if (!raw) return undefined;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
