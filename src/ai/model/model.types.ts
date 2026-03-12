import { LanguageModel } from 'ai';

export type ModelId = string;
export type ModelProvider = 'openai';

export interface ModelProviderConfig {
  provider: ModelProvider;
  apiKey: string;
  baseURL?: string;
}

export interface ModelRegistration {
  id: ModelId;
  provider: ModelProvider;
  displayName?: string;
  model: LanguageModel;
}
