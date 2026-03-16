import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createProviderRegistry, LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { PROVIDER_DEFAULTS } from './types';

/**
 * Provider 注册表 — Layer 1: 纯工厂注册
 *
 * 对标 ZeroClaw src/providers/mod.rs 的 create_provider 工厂。
 * 只负责 "provider名 → SDK实例" 的映射，不含角色路由或容错逻辑。
 *
 * 模型 ID 格式：provider/model（如 anthropic/claude-sonnet-4-6）
 */
@Injectable()
export class RegistryService implements OnModuleInit {
  private readonly logger = new Logger(RegistryService.name);
  private registry!: ReturnType<typeof createProviderRegistry>;
  private readonly registeredProviders: string[] = [];

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providers: Record<string, any> = {};

    // === 原生 AI SDK Provider（有专用 SDK）===
    this.registerNative(providers, 'anthropic', 'ANTHROPIC_API_KEY', (apiKey) =>
      createAnthropic({ apiKey }),
    );
    this.registerNative(providers, 'openai', 'OPENAI_API_KEY', (apiKey) =>
      createOpenAI({ apiKey }),
    );
    this.registerNative(providers, 'google', 'GOOGLE_API_KEY', (apiKey) =>
      createGoogleGenerativeAI({ apiKey }),
    );
    this.registerNative(providers, 'deepseek', 'DEEPSEEK_API_KEY', (apiKey) =>
      createDeepSeek({ apiKey }),
    );

    // === OpenAI-compatible Provider（国内厂商等）===
    for (const [name, cfg] of Object.entries(PROVIDER_DEFAULTS)) {
      // deepseek 已用专用 SDK 注册，跳过
      if (name === 'deepseek') continue;

      const apiKey = this.config.get<string>(cfg.envKey);
      if (!apiKey) continue;

      const baseURL = this.config.get<string>(cfg.baseUrlEnvKey ?? '') ?? cfg.defaultBaseURL;
      providers[name] = createOpenAICompatible({ name, apiKey, baseURL });
      this.registeredProviders.push(name);
      this.logger.log(`Provider 已注册: ${name} (${cfg.displayName})`);
    }

    // === 自定义 OpenAI-compatible 网关 ===
    const gatewayKey = this.config.get<string>('GATEWAY_API_KEY');
    const gatewayUrl = this.config.get<string>('GATEWAY_BASE_URL');
    if (gatewayKey && gatewayUrl) {
      providers['gateway'] = createOpenAI({ apiKey: gatewayKey, baseURL: gatewayUrl });
      this.registeredProviders.push('gateway');
      this.logger.log('Provider 已注册: gateway');
    }

    // Provider SDK 返回值符合 ProviderV3 接口，但 TS 需要显式断言
    this.registry = createProviderRegistry(
      providers as Parameters<typeof createProviderRegistry>[0],
      { separator: '/' },
    );
    this.logger.log(`Provider 注册完成, 共 ${this.registeredProviders.length} 个`);
  }

  /** 通过 "provider/model" 获取 LanguageModel */
  resolve(modelId: string): LanguageModel {
    // registry 类型系统要求精确的 provider key，运行时用 string 调用
    return (this.registry as { languageModel(id: string): LanguageModel }).languageModel(modelId);
  }

  /** 列出已注册的 Provider 名称 */
  listProviders(): string[] {
    return [...this.registeredProviders];
  }

  /** 检查 Provider 是否已注册 */
  hasProvider(name: string): boolean {
    return this.registeredProviders.includes(name);
  }

  private registerNative(
    providers: Record<string, unknown>,
    name: string,
    envKey: string,
    factory: (apiKey: string) => unknown,
  ): void {
    const apiKey = this.config.get<string>(envKey);
    if (!apiKey) return;
    providers[name] = factory(apiKey);
    this.registeredProviders.push(name);
    this.logger.log(`Provider 已注册: ${name}`);
  }
}
