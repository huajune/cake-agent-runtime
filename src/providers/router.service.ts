import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LanguageModel, generateText, streamText } from 'ai';
import { ReliableService } from './reliable.service';
import { ReliableConfig } from './types';

/**
 * 模型路由服务 — Layer 3: 角色 → 模型映射
 *
 * 对标 ZeroClaw src/providers/router.rs 的 RouterProvider。
 *
 * 通过环境变量配置角色映射：
 *   AGENT_CHAT_MODEL=anthropic/claude-sonnet-4-6
 *   AGENT_CHAT_FALLBACKS=openai/gpt-4o,deepseek/deepseek-chat
 *   AGENT_FAST_MODEL=deepseek/deepseek-chat
 *   AGENT_CLASSIFY_MODEL=openai/gpt-4o-mini
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  constructor(
    private readonly reliable: ReliableService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 按角色获取模型
   *
   * @param role - 角色名 (chat, fast, classify, reasoning 等)
   * @returns 带容错的 LanguageModel
   */
  resolveByRole(role: string): LanguageModel {
    const modelId = this.config.get<string>(`AGENT_${role.toUpperCase()}_MODEL`);
    if (!modelId) {
      throw new Error(`角色 "${role}" 未配置模型 (AGENT_${role.toUpperCase()}_MODEL)`);
    }
    const fallbacks = this.parseFallbacks(role);
    return this.reliable.resolveWithFallback(modelId, fallbacks);
  }

  /**
   * 精确调用（不走角色路由）
   *
   * @param modelId - 完整模型 ID (provider/model)
   * @param fallbacks - 降级模型 ID 列表
   */
  resolve(modelId: string, fallbacks?: string[]): LanguageModel {
    return this.reliable.resolveWithFallback(modelId, fallbacks);
  }

  /**
   * 按角色执行 generateText（带完整容错链）
   */
  async generateTextByRole(
    role: string,
    params: Omit<Parameters<typeof generateText>[0], 'model'>,
    config?: Partial<ReliableConfig>,
  ): Promise<Awaited<ReturnType<typeof generateText>>> {
    const modelId = this.config.get<string>(`AGENT_${role.toUpperCase()}_MODEL`);
    if (!modelId) {
      throw new Error(`角色 "${role}" 未配置模型`);
    }
    const fallbacks = this.parseFallbacks(role);
    return this.reliable.generateText(modelId, params, fallbacks, config);
  }

  /**
   * 按角色执行 streamText（带模型降级）
   */
  streamTextByRole(
    role: string,
    params: Omit<Parameters<typeof streamText>[0], 'model'>,
  ): ReturnType<typeof streamText> {
    const modelId = this.config.get<string>(`AGENT_${role.toUpperCase()}_MODEL`);
    if (!modelId) {
      throw new Error(`角色 "${role}" 未配置模型`);
    }
    const fallbacks = this.parseFallbacks(role);
    return this.reliable.streamText(modelId, params, fallbacks);
  }

  /** 列出所有已配置的角色 */
  listRoles(): string[] {
    const roles: string[] = [];
    const envKeys = ['CHAT', 'FAST', 'CLASSIFY', 'REASONING'];
    for (const key of envKeys) {
      if (this.config.get<string>(`AGENT_${key}_MODEL`)) {
        roles.push(key.toLowerCase());
      }
    }
    return roles;
  }

  private parseFallbacks(role: string): string[] | undefined {
    const raw = this.config.get<string>(`AGENT_${role.toUpperCase()}_FALLBACKS`);
    if (!raw) return undefined;
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
