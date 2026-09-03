import type { ModuleRef } from '@nestjs/core';
import { PersistingObserver } from '@observability/persisting-observer';
import { AGENT_EVENT_PERSISTER } from '@observability/persistence/agent-event-persister.interface';
import type { AgentEventPersister } from '@observability/persistence/agent-event-persister.interface';

describe('PersistingObserver', () => {
  const persister: jest.Mocked<AgentEventPersister> = {
    persist: jest.fn(),
  };
  const moduleRef = {
    get: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    persister.persist.mockResolvedValue(undefined);
    moduleRef.get.mockReturnValue(persister);
  });

  function makeObserver(): PersistingObserver {
    const observer = new PersistingObserver(moduleRef as never as ModuleRef);
    observer.onApplicationBootstrap();
    return observer;
  }

  it('resolves the configured persister on application bootstrap', () => {
    makeObserver();

    expect(moduleRef.get).toHaveBeenCalledWith(AGENT_EVENT_PERSISTER, { strict: false });
  });

  it('persists terminal and error-oriented event types', () => {
    const observer = makeObserver();

    observer.emit({ type: 'agent_end', durationMs: 12 });
    observer.emit({ type: 'agent_error', error: 'boom' });
    observer.emit({ type: 'model_fallback', fromModel: 'a', toModel: 'b', reason: 'rate-limit' });
    observer.emit({ type: 'tool_error', toolName: 'geocode', error: 'timeout' });

    expect(persister.persist).toHaveBeenCalledTimes(4);
  });

  it('always persists collection and session-state diagnostics', () => {
    const observer = makeObserver();

    observer.emit({
      type: 'session_state_field_dropped',
      field: 'facts',
      issues: ['facts.age: Invalid input'],
    });
    observer.emit({
      type: 'collection_form_audit',
      jobId: 123,
      kind: 'rejected',
      reason: 'missing_evidence',
    });

    expect(persister.persist).toHaveBeenCalledTimes(2);
  });

  it('always persists prompt-injection hits（一次入侵一条，detectTexts 不回扫历史）', () => {
    const observer = makeObserver();

    observer.emit({
      type: 'prompt_injection_detected',
      ruleId: 'role_hijack_1',
      alertStatus: 'sent',
      evidencePreview: '[手机号已脱敏]',
    });

    expect(persister.persist).toHaveBeenCalledTimes(1);
  });

  it('skips turn assembly diagnostics on a clean fast turn（顺利回合可由同轮输入复现）', () => {
    const observer = makeObserver();

    observer.emit({
      type: 'turn_data_sources',
      status: 'success',
      totalDurationMs: 10,
      sources: [{ source: 'memory', status: 'success', durationMs: 5, observedAt: 'now' }],
    });
    observer.emit({
      type: 'turn_preparation',
      status: 'success',
      totalDurationMs: 12,
      phaseDurationsMs: { load_sources: 10 },
      prompt: {
        totalChars: 1000,
        estimatedTokens: 250,
        orderHash: 'hash',
        blocks: [],
        dynamicBlockIds: [],
      },
    });

    expect(persister.persist).not.toHaveBeenCalled();
  });

  it('persists turn assembly diagnostics when a source degraded, it failed, or it ran slow', () => {
    const observer = makeObserver();

    // 源降级：正是「读取失败被当成空结果」要靠事件表回溯的那一类回合。
    observer.emit({
      type: 'turn_data_sources',
      status: 'success',
      totalDurationMs: 10,
      sources: [{ source: 'memory', status: 'degraded', durationMs: 5, observedAt: 'now' }],
    });
    observer.emit({
      type: 'turn_data_sources',
      status: 'failure',
      totalDurationMs: 8,
      sources: [],
      error: 'boom',
    });
    observer.emit({
      type: 'turn_preparation',
      status: 'failure',
      totalDurationMs: 12,
      phaseDurationsMs: {},
      error: 'boom',
    });
    observer.emit({
      type: 'turn_preparation',
      status: 'success',
      totalDurationMs: 9000,
      phaseDurationsMs: {},
    });

    expect(persister.persist).toHaveBeenCalledTimes(4);
  });

  it('always persists llm_execution regardless of status or attempt count', () => {
    const observer = makeObserver();

    // 单次干净成功也必须落库——任何"只落异常"的条件过滤都会复刻 tool_call 漏采根因。
    observer.emit({
      type: 'llm_execution',
      role: 'chat',
      mode: 'generate',
      primaryModelId: 'qwen/qwen3.7-plus',
      finalModelId: 'qwen/qwen3.7-plus',
      status: 'success',
      attemptCount: 1,
      totalDurationMs: 1200,
      backoffTotalMs: 0,
      attempts: [
        {
          modelId: 'qwen/qwen3.7-plus',
          attempt: 1,
          startOffsetMs: 0,
          durationMs: 1200,
          status: 'success',
        },
      ],
    });

    expect(persister.persist).toHaveBeenCalledTimes(1);
  });

  it('persists only material tool calls', () => {
    const observer = makeObserver();

    observer.emit({ type: 'tool_call', toolName: 'normal', status: 'ok', durationMs: 2999 });
    observer.emit({ type: 'tool_call', toolName: 'side-effect', status: 'ok', sideEffect: true });
    observer.emit({ type: 'tool_call', toolName: 'failed-tool', status: 'error' });
    observer.emit({ type: 'tool_call', toolName: 'slow-tool', status: 'ok', durationMs: 3000 });

    expect(persister.persist).toHaveBeenCalledTimes(3);
    expect(persister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call', toolName: 'side-effect' }),
    );
    expect(persister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call', toolName: 'failed-tool' }),
    );
    expect(persister.persist).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tool_call', toolName: 'slow-tool' }),
    );
  });

  it('persists empty / narrow tool calls（观测 P1-4：假无岗与窄召回趋势的唯一长期来源）', () => {
    const observer = makeObserver();

    observer.emit({ type: 'tool_call', toolName: 'job-search', status: 'empty', durationMs: 800 });
    observer.emit({ type: 'tool_call', toolName: 'job-search', status: 'narrow', durationMs: 900 });
    observer.emit({ type: 'tool_call', toolName: 'job-search', status: 'ok', durationMs: 900 });

    expect(persister.persist).toHaveBeenCalledTimes(2);
    expect(persister.persist).toHaveBeenCalledWith(expect.objectContaining({ status: 'empty' }));
    expect(persister.persist).toHaveBeenCalledWith(expect.objectContaining({ status: 'narrow' }));
  });

  it('always persists guardrail process events（观测 P1-2：repair 终局与入站拦截）', () => {
    const observer = makeObserver();

    observer.emit({
      type: 'guardrail_repair',
      outcome: 'repair_exhausted_fail_open',
      finalDecision: 'pass',
      riskLevel: 'medium',
      firstRuleIds: ['schedule_window_claim'],
      finalRuleIds: ['schedule_window_claim'],
      repairMode: 'rewrite',
    });
    observer.emit({
      type: 'inbound_guardrail_block',
      reasonCode: 'risk_intercept',
      riskType: 'self_harm',
    });

    expect(persister.persist).toHaveBeenCalledTimes(2);
  });

  it('skips events when no persister is registered', () => {
    moduleRef.get.mockImplementationOnce(() => {
      throw new Error('not registered');
    });
    const observer = new PersistingObserver(moduleRef as never as ModuleRef);
    observer.onApplicationBootstrap();

    expect(() => observer.emit({ type: 'agent_end', durationMs: 12 })).not.toThrow();
    expect(persister.persist).not.toHaveBeenCalled();
  });

  it('swallows async persistence failures', async () => {
    persister.persist.mockRejectedValueOnce(new Error('db down'));
    const observer = makeObserver();

    expect(() => observer.emit({ type: 'agent_end', durationMs: 12 })).not.toThrow();
    await Promise.resolve();
  });
});
