import { CompositeObserver } from '@observability/composite-observer';
import type { Observer } from '@observability/observer.interface';

describe('CompositeObserver', () => {
  const loggerObserver: jest.Mocked<Observer> = {
    emit: jest.fn(),
  };
  const persistingObserver: jest.Mocked<Observer> = {
    emit: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fans out each event to logger and persisting observers', () => {
    const observer = new CompositeObserver(loggerObserver as never, persistingObserver as never);
    const event = { type: 'model_call', modelId: 'gpt-5', role: 'primary' } as const;

    observer.emit(event);

    expect(loggerObserver.emit).toHaveBeenCalledWith(event);
    expect(persistingObserver.emit).toHaveBeenCalledWith(event);
  });

  it('continues fan-out when one observer throws', () => {
    loggerObserver.emit.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });
    const observer = new CompositeObserver(loggerObserver as never, persistingObserver as never);
    const event = { type: 'tool_error', toolName: 'geocode', error: 'timeout' } as const;

    expect(() => observer.emit(event)).not.toThrow();
    expect(persistingObserver.emit).toHaveBeenCalledWith(event);
  });
});
