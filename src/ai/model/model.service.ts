import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import { LanguageModel } from 'ai';
import { ModelRegistration } from './model.types';
@Injectable()
export class ModelService implements OnModuleInit {
  private readonly logger = new Logger(ModelService.name);
  private readonly registry = new Map();
  private defaultModelId = 'default';
  constructor(private readonly configService: ConfigService) {}
  onModuleInit() {
    this.initDefaultModel();
  }
  register(reg: ModelRegistration): void {
    this.registry.set(reg.id, reg);
    this.logger.log('模型已注册: ' + reg.id);
  }
  get(modelId = this.defaultModelId): LanguageModel {
    const r = this.registry.get(modelId);
    if (!r) throw new Error('模型未注册: ' + modelId);
    return r.model;
  }
  list(): string[] {
    return [...this.registry.keys()];
  }
  setDefault(id: string): void {
    this.defaultModelId = id;
  }
  private initDefaultModel(): void {
    const apiKey = this.configService.get('AGENT_API_KEY');
    const baseURL = this.configService.get('AGENT_API_BASE_URL');
    const modelName = this.configService.get('AGENT_MODEL') ?? 'claude-sonnet-4-6';
    if (!apiKey || !baseURL) {
      this.logger.warn('AGENT_API_KEY/AGENT_API_BASE_URL 未配置');
      return;
    }
    const p = createOpenAI({ apiKey, baseURL });
    this.register({
      id: 'default',
      provider: 'openai',
      displayName: modelName,
      model: p(modelName),
    });
    this.logger.log('默认模型: ' + modelName);
  }
}
