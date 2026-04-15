import { TypingPolicyService } from '@channels/wecom/message/delivery/typing-policy.service';

describe('TypingPolicyService', () => {
  const runtimeConfig = {
    isMessageSplitSendEnabled: jest.fn(),
    getTypingConfig: jest.fn(),
  };

  let service: TypingPolicyService;

  beforeEach(() => {
    jest.clearAllMocks();
    runtimeConfig.isMessageSplitSendEnabled.mockReturnValue(true);
    runtimeConfig.getTypingConfig.mockReturnValue({
      typingSpeedCharsPerSec: 10,
      paragraphGapMs: 3000,
    });
    service = new TypingPolicyService(runtimeConfig as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should only split when runtime split-send is enabled and content needs splitting', () => {
    expect(service.shouldSplit('第一段\n\n第二段')).toBe(true);

    runtimeConfig.isMessageSplitSendEnabled.mockReturnValue(false);

    expect(service.shouldSplit('第一段\n\n第二段')).toBe(false);
  });

  it('should return zero delay for the first segment', () => {
    expect(service.calculateDelay('欢迎了解岗位信息', true)).toBe(0);
  });

  it('should respect paragraph gap and expose the current typing snapshot', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(service.calculateDelay('12345')).toBe(3000);
    expect(service.getSnapshot()).toEqual({
      splitSend: true,
      typingSpeedCharsPerSec: 10,
      paragraphGapMs: 3000,
    });
  });
});
