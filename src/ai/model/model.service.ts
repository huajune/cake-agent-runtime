import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import { LanguageModel } from 'ai';
import { ModelRegistration } from './model.types';

/**
 * 模型注册表 — 单网关 + 单 Key + 纯注册表
 *
 * 所有模型共享同一个 OpenAI-compatible 网关（AGENT_API_BASE_URL），
 * 通过 model name 区分。调用方自己决定用哪个模型。
 *
 * 借鉴花卷：validate → fallback to default 模式。
 */
@Injectable()
export class ModelService implements OnModuleInit {
  private readonly logger = new Logger(ModelService.name);
  private readonly models = new Map<string, LanguageModel>();
  private readonly registrations = new Map<string, ModelRegistration>();
  private provider!: ReturnType<typeof createOpenAI>;
  private defaultModelId = 'default';

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.initProvider();
    this.initDefaultModel();
    this.initAdditionalModels();
  }

  /** 严格获取 — 不存在则抛错 */
  get(modelId = this.defaultModelId): LanguageModel {
    const model = this.models.get(modelId);
    if (!model) throw new Error('模型未注册: ' + modelId);
    return model;
  }

  /** 宽松获取 — 不存在返回默认模型（借鉴花卷 validateModel） */
  resolve(modelId?: string): LanguageModel {
    if (!modelId) return this.get();
    const model = this.models.get(modelId);
    if (model) return model;
    this.logger.warn(`模型 ${modelId} 未注册，回退到默认模型`);
    return this.get();
  }

  /** 列出所有已注册模型 ID */
  list(): string[] {
    return [...this.models.keys()];
  }

  /** 检查模型是否已注册 */
  has(modelId: string): boolean {
    return this.models.has(modelId);
  }

  private initProvider(): void {
    const apiKey = this.configService.get<string>('AGENT_API_KEY');
    const baseURL = this.configService.get<string>('AGENT_API_BASE_URL');

    if (!apiKey || !baseURL) {
      this.logger.warn('AGENT_API_KEY/AGENT_API_BASE_URL 未配置');
      return;
    }

    this.provider = createOpenAI({ apiKey, baseURL });
  }

  private initDefaultModel(): void {
    if (!this.provider) return;

    const modelName = this.configService.get<string>('AGENT_MODEL') ?? 'claude-sonnet-4-6';
    this.register('default', modelName);
    this.logger.log('默认模型: ' + modelName);
  }

  /**
   * 从环境变量注册额外模型（共享同一个 provider）
   * 格式: AI_MODEL_IDS=fast,mini + AI_MODEL_FAST_NAME=gpt-4o-mini
   */
  private initAdditionalModels(): void {
    if (!this.provider) return;

    const modelIds = this.configService.get<string>('AI_MODEL_IDS');
    if (!modelIds) return;

    for (const id of modelIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const modelName = this.configService.get<string>(`AI_MODEL_${id.toUpperCase()}_NAME`);
      if (!modelName) {
        this.logger.warn(`模型 ${id} 缺少 NAME 配置，跳过`);
        continue;
      }
      this.register(id, modelName);
    }
  }

  private register(id: string, modelName: string): void {
    this.models.set(id, this.provider(modelName));
    this.registrations.set(id, { id, displayName: modelName });
    this.logger.log('模型已注册: ' + id + ' (' + modelName + ')');
  }
}
