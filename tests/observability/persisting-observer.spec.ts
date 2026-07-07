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
