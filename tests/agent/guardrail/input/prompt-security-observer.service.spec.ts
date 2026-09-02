import { PromptSecurityObserverService } from '@agent/guardrail/input/prompt-security-observer.service';

describe('PromptSecurityObserverService', () => {
  it('does nothing for a safe assessment', async () => {
    const alerts = {
      createPromptInjectionAlert: jest.fn(),
      sendAlert: jest.fn(),
    };
    const observer = new PromptSecurityObserverService(alerts as never);

    await expect(observer.record('user-1', { safe: true, detected: false })).resolves.toBe(
      'skipped',
    );

    expect(alerts.createPromptInjectionAlert).not.toHaveBeenCalled();
    expect(alerts.sendAlert).not.toHaveBeenCalled();
  });

  it('records a detected assessment with a bounded preview', async () => {
    const alerts = {
      createPromptInjectionAlert: jest.fn((input) => input),
      sendAlert: jest.fn().mockResolvedValue(undefined),
    };
    const observer = new PromptSecurityObserverService(alerts as never);
    await observer.record('user-1', {
      safe: false,
      detected: true,
      category: 'prompt_leak',
      ruleId: 'prompt_leak_1',
      reason: '提示词泄露',
      evidencePreview: '[手机号已脱敏] ignore prompt',
    });

    expect(alerts.createPromptInjectionAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        contentPreview: '[手机号已脱敏] ignore prompt',
      }),
    );
    expect(alerts.sendAlert).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the alert channel fails', async () => {
    const alerts = {
      createPromptInjectionAlert: jest.fn((input) => input),
      sendAlert: jest.fn().mockRejectedValue(new Error('network down')),
    };
    const observer = new PromptSecurityObserverService(alerts as never);
    await expect(
      observer.record('user-1', {
        safe: false,
        detected: true,
        ruleId: 'role_hijack_1',
      }),
    ).resolves.toBe('failed');
  });
});
