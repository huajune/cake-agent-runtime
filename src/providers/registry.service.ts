import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createProviderRegistry, LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createCustomOpenAI } from './custom-openai.provider';
import { createCustomOpenRouter } from './custom-openrouter.provider';
import { PROVIDER_DEFAULTS } from './types';
import { MODEL_DICTIONARY, ModelEntry, getModelsByProvider } from './models';

/**
 * Provider 注册表 — Layer 1: 纯工厂注册
 *
 * 只负责 "provider名 → SDK实例" 的映射，不含角色路由或容错逻辑。
 *
 * 模型 ID 格式：provider/model（如 anthropic/claude-sonnet-4-6）
 *
 * Provider 分类：
 * - 原生 SDK：anthropic, google, deepseek
 * - 自定义：openai (代理, 强制 chat 端点), openrouter (官方 SDK + Kimi K2 修复)
 * - OpenAI-compatible：qwen, moonshotai, ohmygpt
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
      createAnthropic({
        apiKey,
        baseURL: this.config.get<string>('ANTHROPIC_BASE_URL'),
      }),
    );
    this.registerNative(providers, 'google', 'GEMINI_API_KEY', (apiKey) =>
      createGoogleGenerativeAI({
        apiKey,
        baseURL: this.config.get<string>('GOOGLE_BASE_URL'),
      }),
    );
    this.registerNative(providers, 'deepseek', 'DEEPSEEK_API_KEY', (apiKey) =>
      createDeepSeek({
        apiKey,
        baseURL: this.config.get<string>('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
      }),
    );

    // === 自定义 Provider ===
    // OpenAI — 通过代理访问，强制使用 /v1/chat/completions 端点
    const anthropicKey = this.config.get<string>('ANTHROPIC_API_KEY');
    const openaiBaseURL = this.config.get<string>('OPENAI_BASE_URL');
    if (anthropicKey) {
      providers['openai'] = createCustomOpenAI({ apiKey: anthropicKey, baseURL: openaiBaseURL });
      this.registeredProviders.push('openai');
      this.logger.log('Provider 已注册: openai (代理)');
    }

    // OpenRouter — 官方 SDK + Kimi K2 tool_calls 修复
    const openrouterKey = this.config.get<string>('OPENROUTER_API_KEY');
    if (openrouterKey) {
      const baseURL = this.config.get<string>('OPENROUTER_BASE_URL');
      providers['openrouter'] = createCustomOpenRouter({ apiKey: openrouterKey, baseURL });
      this.registeredProviders.push('openrouter');
      this.logger.log('Provider 已注册: openrouter');
    }

    // === OpenAI-compatible Provider（国内厂商等）===
    for (const [name, cfg] of Object.entries(PROVIDER_DEFAULTS)) {
      // deepseek 已用专用 SDK 注册，跳过
      if (name === 'deepseek') continue;

      const apiKey = this.config.get<string>(cfg.envKey);
      if (!apiKey) continue;

      const baseURL = this.config.get<string>(cfg.baseUrlEnvKey ?? '') ?? cfg.defaultBaseURL;
      providers[name] = createOpenAICompatible({ name, apiKey, baseURL, includeUsage: true });
      this.registeredProviders.push(name);
      this.logger.log(`Provider 已注册: ${name} (${cfg.displayName})`);
    }

    // === 自定义 OpenAI-compatible 网关 ===
    const gatewayKey = this.config.get<string>('GATEWAY_API_KEY');
    const gatewayUrl = this.config.get<string>('GATEWAY_BASE_URL');
    if (gatewayKey && gatewayUrl) {
      providers['gateway'] = createOpenAICompatible({
        name: 'gateway',
        apiKey: gatewayKey,
        baseURL: gatewayUrl,
      });
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

  /** 列出当前可用的所有模型（按已注册 Provider 过滤） */
  listModels(): Array<{ id: string } & ModelEntry> {
    return this.registeredProviders.flatMap((provider) =>
      getModelsByProvider(provider).map((id) => ({ id, ...MODEL_DICTIONARY[id] })),
    );
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
