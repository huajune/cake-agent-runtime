import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type LanguageModel, wrapProvider } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { captureProviderFetch } from '@observability/context/model-invocations';
import { jsonSchemaInPromptMiddleware } from './json-schema-prompt.middleware';
import {
  MODEL_DICTIONARY,
  ModelEntry,
  ModelProvider,
  getModelsByProvider,
  supportedModelId,
} from './models';

// Each outbound model request gets a fresh deadline, including reads of the response body.
const fetchModel: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(120_000);
  const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  return fetch(input, { ...init, signal: caller ? AbortSignal.any([caller, timeout]) : timeout });
};

@Injectable()
export class RegistryService implements OnModuleInit {
  private readonly logger = new Logger(RegistryService.name);
  private readonly providers = new Map<string, { languageModel(id: string): LanguageModel }>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.providers.clear();
    const qwenKey = this.config.get<string>('DASHSCOPE_API_KEY');
    if (qwenKey) {
      this.providers.set(
        ModelProvider.Qwen,
        wrapProvider({
          provider: createOpenAICompatible({
            name: ModelProvider.Qwen,
            apiKey: qwenKey,
            fetch: captureProviderFetch(ModelProvider.Qwen, fetchModel),
            baseURL:
              this.config.get<string>('QWEN_BASE_URL') ??
              'https://dashscope.aliyuncs.com/compatible-mode/v1',
            includeUsage: true,
          }),
          languageModelMiddleware: jsonSchemaInPromptMiddleware,
        }),
      );
    }
    const deepseekKey = this.config.get<string>('DEEPSEEK_API_KEY');
    if (deepseekKey) {
      this.providers.set(
        ModelProvider.DeepSeek,
        createDeepSeek({
          apiKey: deepseekKey,
          fetch: captureProviderFetch(ModelProvider.DeepSeek, fetchModel),
          baseURL: this.config.get<string>('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
        }),
      );
    }
    this.logger.log(`已注册模型供应商: ${this.listProviders().join(', ')}`);
  }

  resolve(modelId: string): LanguageModel {
    const id = supportedModelId(modelId);
    if (!id) throw new Error(`不支持的模型供应商或模型 ID: ${modelId}`);
    const [name, model] = id.split('/');
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`未注册模型供应商: ${name}`);
    return provider.languageModel(model);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listModels(): Array<{ id: string } & ModelEntry> {
    return this.listProviders().flatMap((provider) =>
      getModelsByProvider(provider).map((id) => ({ id, ...MODEL_DICTIONARY[id] })),
    );
  }
}
