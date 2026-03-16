import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RegistryService } from '@providers/registry.service';

// Mock AI SDK modules
jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: jest.fn(() => ({ type: 'openai-provider' })),
}));
jest.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: jest.fn(() => ({ type: 'anthropic-provider' })),
}));
jest.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: jest.fn(() => ({ type: 'google-provider' })),
}));
jest.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: jest.fn(() => ({ type: 'deepseek-provider' })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(({ name }) => ({ type: `${name}-compatible` })),
}));

const mockLanguageModel = { modelId: 'test-model', specificationVersion: 'v1' };
const mockRegistry = {
  languageModel: jest.fn().mockReturnValue(mockLanguageModel),
};
jest.mock('ai', () => ({
  createProviderRegistry: jest.fn(() => mockRegistry),
}));

describe('RegistryService', () => {
  let service: RegistryService;
  let mockConfigService: { get: jest.Mock };

  function createService(envOverrides: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-openai-test',
      GOOGLE_API_KEY: 'google-test',
      DEEPSEEK_API_KEY: 'deepseek-test',
      ...envOverrides,
    };

    mockConfigService = {
      get: jest.fn((key: string) => env[key]),
    };

    return Test.createTestingModule({
      providers: [
        RegistryService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await createService();
    service = module.get<RegistryService>(RegistryService);
    service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should register native providers with API keys', () => {
      const { createAnthropic } = require('@ai-sdk/anthropic');
      const { createOpenAI } = require('@ai-sdk/openai');
      const { createGoogleGenerativeAI } = require('@ai-sdk/google');
      const { createDeepSeek } = require('@ai-sdk/deepseek');

      expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'sk-ant-test' });
      expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-openai-test' });
      expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'google-test' });
      expect(createDeepSeek).toHaveBeenCalledWith({ apiKey: 'deepseek-test' });
    });

    it('should skip native providers without API keys', async () => {
      jest.clearAllMocks();
      const module = await createService({
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        DEEPSEEK_API_KEY: undefined,
      });
      const svc = module.get<RegistryService>(RegistryService);
      svc.onModuleInit();

      const { createAnthropic } = require('@ai-sdk/anthropic');
      const { createOpenAI } = require('@ai-sdk/openai');
      expect(createAnthropic).not.toHaveBeenCalled();
      expect(createOpenAI).not.toHaveBeenCalled();
    });

    it('should register OpenAI-compatible providers with API keys', async () => {
      jest.clearAllMocks();
      const module = await createService({
        QWEN_API_KEY: 'qwen-test',
        ZHIPU_API_KEY: 'zhipu-test',
      });
      const svc = module.get<RegistryService>(RegistryService);
      svc.onModuleInit();

      const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
      expect(createOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'qwen', apiKey: 'qwen-test' }),
      );
      expect(createOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'zhipu', apiKey: 'zhipu-test' }),
      );
    });

    it('should register gateway when both key and URL are present', async () => {
      jest.clearAllMocks();
      const module = await createService({
        GATEWAY_API_KEY: 'gw-key',
        GATEWAY_BASE_URL: 'https://gw.example.com/v1',
      });
      const svc = module.get<RegistryService>(RegistryService);
      svc.onModuleInit();

      const { createOpenAI } = require('@ai-sdk/openai');
      expect(createOpenAI).toHaveBeenCalledWith({
        apiKey: 'gw-key',
        baseURL: 'https://gw.example.com/v1',
      });
      expect(svc.hasProvider('gateway')).toBe(true);
    });

    it('should not register gateway when key is missing', async () => {
      jest.clearAllMocks();
      const module = await createService({
        GATEWAY_BASE_URL: 'https://gw.example.com/v1',
      });
      const svc = module.get<RegistryService>(RegistryService);
      svc.onModuleInit();

      expect(svc.hasProvider('gateway')).toBe(false);
    });

    it('should call createProviderRegistry with separator /', () => {
      const { createProviderRegistry } = require('ai');
      expect(createProviderRegistry).toHaveBeenCalledWith(
        expect.any(Object),
        { separator: '/' },
      );
    });

    it('should skip deepseek in compatible loop (already registered natively)', async () => {
      jest.clearAllMocks();
      const module = await createService({ DEEPSEEK_API_KEY: 'ds-test' });
      const svc = module.get<RegistryService>(RegistryService);
      svc.onModuleInit();

      const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
      const calls = createOpenAICompatible.mock.calls;
      const deepseekCompatCalls = calls.filter(
        (c: unknown[]) => (c[0] as { name: string }).name === 'deepseek',
      );
      expect(deepseekCompatCalls).toHaveLength(0);
    });
  });

  describe('resolve', () => {
    it('should delegate to registry.languageModel', () => {
      const result = service.resolve('anthropic/claude-sonnet-4-6');
      expect(mockRegistry.languageModel).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
      expect(result).toBe(mockLanguageModel);
    });

    it('should propagate registry errors', () => {
      mockRegistry.languageModel.mockImplementationOnce(() => {
        throw new Error('Provider not found');
      });
      expect(() => service.resolve('unknown/model')).toThrow('Provider not found');
    });
  });

  describe('listProviders', () => {
    it('should list all registered providers', () => {
      const providers = service.listProviders();
      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
      expect(providers).toContain('google');
      expect(providers).toContain('deepseek');
    });

    it('should return a copy of the array', () => {
      const list1 = service.listProviders();
      const list2 = service.listProviders();
      expect(list1).not.toBe(list2);
      expect(list1).toEqual(list2);
    });
  });

  describe('hasProvider', () => {
    it('should return true for registered provider', () => {
      expect(service.hasProvider('anthropic')).toBe(true);
    });

    it('should return false for unregistered provider', () => {
      expect(service.hasProvider('nonexistent')).toBe(false);
    });
  });
});
