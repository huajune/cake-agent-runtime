import type {
  ActionCallbacks,
  ActionExecution,
  ActionIntent,
} from '@biz/action-execution/action-execution.types';

/** Business-boundary tests isolate transport and local writes; durable executor is tested separately. */
export function createActionExecutorFixture() {
  return {
    execute: jest.fn(
      async <T>(
        _intent: ActionIntent,
        callbacks: ActionCallbacks<T>,
      ): Promise<ActionExecution<T>> => {
        let completion;
        try {
          completion = await callbacks.dispatch('test-request-id', 'observe');
        } catch {
          completion = {
            status: 'unknown' as const,
            evidence: { kind: 'indeterminate' as const, requestTerminated: false },
          };
        }
        let localSync: 'complete' | 'pending' = 'complete';
        if (completion.status === 'succeeded' && callbacks.sync) {
          try {
            await callbacks.sync(completion.result);
          } catch {
            localSync = 'pending';
          }
        }
        return {
          actionId: 'test-action-id',
          requestId: 'test-request-id',
          status: completion.status,
          result: 'result' in completion ? completion.result : undefined,
          evidence: completion.evidence,
          localSync,
          dispatched: true,
        };
      },
    ),
  };
}
