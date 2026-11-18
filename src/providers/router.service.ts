import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModelRole } from './types';
import { configuredFallbackModels, supportedModelId } from './models';

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
 *   AGENT_CHAT_MODEL=qwen/qwen3.7-plus
 *   AGENT_CHAT_FALLBACKS=deepseek/deepseek-flash
 *   AGENT_EXTRACT_MODEL=qwen/qwen3.7-plus
 *   AGENT_VISION_MODEL=qwen/qwen3-vl-plus
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  constructor(private readonly config: ConfigService) {}

  /** 列出所有已配置的角色 */
  listRoles(): ModelRole[] {
    return Object.values(ModelRole).filter((role) => this.getModelIdByRole(role));
  }

  /** 列出所有已配置角色的详细信息（角色 → 模型 + fallbacks） */
  listRoleDetails(): Record<string, { model: string; fallbacks?: string[] }> {
    const details: Record<string, { model: string; fallbacks?: string[] }> = {};
    for (const role of this.listRoles()) {
      const model = this.getModelIdByRole(role);
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
    return supportedModelId(this.config.get<string>(`AGENT_${role.toUpperCase()}_MODEL`));
  }

  /** 获取指定角色的执行路由（primary + fallback 链）。 */
  getRouteByRole(role: ModelRole | string): ModelRoute {
    return this.buildRoleRoute(role, this.parseFallbacks(role));
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
    const explicitModel = options.overrideModelId?.trim();
    const fallbacks = options.disableFallbacks
      ? undefined
      : (options.fallbacks?.map((id) => this.requireSupportedModel(id)) ?? this.getFallbacks(role));

    if (explicitModel) {
      return { modelId: this.requireSupportedModel(explicitModel), fallbacks };
    }
    return this.buildRoleRoute(role, fallbacks);
  }

  /** chat turn 路径的便捷别名；当前仅被单测覆盖，生产路径（llm-executor）直接调 resolveRoute。 */
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

  private requireSupportedModel(value: string): string {
    const id = supportedModelId(value);
    if (!id) throw new BadRequestException(`不支持的模型 ID: ${value}，请选择 Qwen 或 DeepSeek`);
    return id;
  }

  private parseFallbacks(role: ModelRole | string): string[] | undefined {
    const raw =
      this.config.get<string>(`AGENT_${role.toUpperCase()}_FALLBACKS`) ||
      this.config.get<string>('AGENT_DEFAULT_FALLBACKS');
    if (!raw) return undefined;
    const ids = configuredFallbackModels(raw.split(','));
    return ids.length ? ids : undefined;
  }

  private buildRoleRoute(role: ModelRole | string, fallbacks: string[] | undefined): ModelRoute {
    const modelId = this.getModelIdByRole(role);
    if (!modelId && fallbacks && fallbacks.length > 0) {
      const [fallbackAsPrimary, ...remainingFallbacks] = fallbacks;
      this.logger.warn(
        `角色 "${role}" 未配置主模型，使用降级链首个模型承接 (${fallbackAsPrimary})`,
      );
      return {
        modelId: fallbackAsPrimary,
        fallbacks: remainingFallbacks.length > 0 ? remainingFallbacks : undefined,
      };
    }
    if (!modelId) {
      throw new Error(`角色 "${role}" 未配置模型 (AGENT_${role.toUpperCase()}_MODEL)`);
    }
    return {
      modelId,
      fallbacks,
    };
  }
}
