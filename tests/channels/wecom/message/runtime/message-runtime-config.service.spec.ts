import { DEFAULT_AGENT_REPLY_CONFIG } from '@biz/hosting-config/types/hosting-config.types';
import { MessageRuntimeConfigService } from '@channels/wecom/message/runtime/message-runtime-config.service';

describe('MessageRuntimeConfigService', () => {
  const configCallbacks: {
    aiReply?: (enabled: boolean) => void;
    messageMerge?: (enabled: boolean) => void;
    agentReply?: (config: typeof DEFAULT_AGENT_REPLY_CONFIG) => void;
  } = {};

  const configService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      if (key === 'AGENT_CHAT_MODEL') {
        return 'gpt-env-default';
      }
      if (key === 'AGENT_THINKING_BUDGET_TOKENS') {
        return '0';
      }
      return defaultValue;
    }),
  };

  const systemConfigService = {
    onAiReplyChange: jest.fn((callback: (enabled: boolean) => void) => {
      configCallbacks.aiReply = callback;
    }),
    onMessageMergeChange: jest.fn((callback: (enabled: boolean) => void) => {
      configCallbacks.messageMerge = callback;
    }),
    onAgentReplyConfigChange: jest.fn(
      (callback: (config: typeof DEFAULT_AGENT_REPLY_CONFIG) => void) => {
        configCallbacks.agentReply = callback;
      },
    ),
    getAiReplyEnabled: jest.fn(),
    getMessageMergeEnabled: jest.fn(),
    getAgentReplyConfig: jest.fn(),
  };

  let service: MessageRuntimeConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    configCallbacks.aiReply = undefined;
    configCallbacks.messageMerge = undefined;
    configCallbacks.agentReply = undefined;
    service = new MessageRuntimeConfigService(configService as never, systemConfigService as never);
  });

  it('should load runtime values on module init', async () => {
    systemConfigService.getAiReplyEnabled.mockResolvedValue(false);
    systemConfigService.getMessageMergeEnabled.mockResolvedValue(false);
    systemConfigService.getAgentReplyConfig.mockResolvedValue({
      ...DEFAULT_AGENT_REPLY_CONFIG,
      wecomCallbackModelId: 'gpt-runtime',
      wecomCallbackThinkingMode: 'deep',
      initialMergeWindowMs: 4500,
      typingSpeedCharsPerSec: 12,
      paragraphGapMs: 1500,
    });

    await service.onModuleInit();

    expect(service.isAiReplyEnabled()).toBe(false);
    expect(service.isMessageMergeEnabled()).toBe(false);
    expect(service.getMergeDelayMs()).toBe(4500);
    expect(service.getTypingConfig()).toEqual({
      typingSpeedCharsPerSec: 12,
      paragraphGapMs: 1500,
    });
  });

  it('should react to subscribed config callbacks after construction', () => {
    configCallbacks.aiReply?.(false);
    configCallbacks.messageMerge?.(false);
    configCallbacks.agentReply?.({
      ...DEFAULT_AGENT_REPLY_CONFIG,
      initialMergeWindowMs: 5200,
      wecomCallbackThinkingMode: 'deep',
      typingSpeedCharsPerSec: 9,
      paragraphGapMs: 800,
    });

    expect(service.isAiReplyEnabled()).toBe(false);
    expect(service.isMessageMergeEnabled()).toBe(false);
    expect(service.getMergeDelayMs()).toBe(5200);
    expect(service.getTypingConfig()).toEqual({
      typingSpeedCharsPerSec: 9,
      paragraphGapMs: 800,
    });
  });

  it('should prefer a runtime model override and fallback to the env model otherwise', async () => {
    systemConfigService.getAgentReplyConfig.mockResolvedValueOnce({
      ...DEFAULT_AGENT_REPLY_CONFIG,
      wecomCallbackModelId: 'gpt-runtime',
    });

    await expect(service.resolveWecomChatModelSelection()).resolves.toEqual({
      overrideModelId: 'gpt-runtime',
      effectiveModelId: 'gpt-runtime',
      thinkingMode: 'fast',
      thinking: {
        type: 'disabled',
        budgetTokens: 0,
      },
    });

    systemConfigService.getAgentReplyConfig.mockResolvedValueOnce({
      ...DEFAULT_AGENT_REPLY_CONFIG,
      wecomCallbackModelId: '',
      wecomCallbackThinkingMode: 'deep',
    });

    await expect(service.resolveWecomChatModelSelection()).resolves.toEqual({
      overrideModelId: undefined,
      effectiveModelId: 'gpt-env-default',
      thinkingMode: 'deep',
      thinking: {
        type: 'enabled',
        budgetTokens: 4000,
      },
    });
  });
});
