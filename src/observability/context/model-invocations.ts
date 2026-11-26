import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Base64 carries exact HTTP entity bytes through the JSON RPC to PostgreSQL bytea. */
export interface ModelInvocation {
  id: string;
  provider: string;
  startedAt: string;
  httpStatus: number | null;
  complete: boolean;
  requestBody: string | null;
  responseBody: string | null;
}

interface Exchange extends Omit<ModelInvocation, 'responseBody'> {
  chunks: Buffer[];
}

interface CaptureScope {
  messageId: string;
  attempts: Exchange[];
  generating: boolean;
}

const scopes = new AsyncLocalStorage<CaptureScope>();

export async function withProcessingTurn<T>(messageId: string, work: () => Promise<T>): Promise<T> {
  const turn: CaptureScope = { messageId, attempts: [], generating: false };
  try {
    return await scopes.run(turn, work);
  } finally {
    turn.attempts.length = 0;
  }
}

/** Only observe calls made to generate this reply, including tool steps and fallback attempts. */
export async function captureReplyGeneration<T>(work: () => Promise<T>): Promise<T> {
  const turn = scopes.getStore();
  if (!turn) return work();
  const scope = { ...turn, generating: true };
  try {
    return await scopes.run(scope, work);
  } finally {
    scope.generating = false;
  }
}

export function takeModelInvocations(messageId: string): ModelInvocation[] | undefined {
  const turn = scopes.getStore();
  if (turn?.messageId !== messageId || !turn.attempts.length) return undefined;
  return turn.attempts.splice(0).map(({ chunks, ...call }) => ({
    ...call,
    responseBody: call.httpStatus === null ? null : Buffer.concat(chunks).toString('base64'),
  }));
}

function requestStartedAt(): string {
  // Microseconds distinguish starts in the same millisecond without an extra sequence column.
  const micros = Math.floor((performance.timeOrigin + performance.now()) * 1000);
  return new Date(Math.floor(micros / 1000))
    .toISOString()
    .replace('Z', `${String(micros % 1000).padStart(3, '0')}Z`);
}

export function captureProviderFetch(provider: string, send: typeof fetch): typeof fetch {
  return async (input, init) => {
    const scope = scopes.getStore();
    if (!scope?.generating) return send(input, init);
    const call: Exchange = {
      id: randomUUID(),
      startedAt: requestStartedAt(),
      provider,
      httpStatus: null,
      requestBody: null,
      chunks: [],
      complete: false,
    };
    scope.attempts.push(call);
    let response: Response;
    if (typeof init?.body === 'string') {
      // Both provider SDKs send serialized JSON. Capture after all provider transformations.
      call.requestBody = Buffer.from(init.body).toString('base64');
      response = await send(input, init);
    } else {
      const request = new Request(input, init);
      const body = request.body
        ? request
            .clone()
            .arrayBuffer()
            .then(
              (bytes) => {
                call.requestBody = Buffer.from(bytes).toString('base64');
              },
              () => undefined,
            )
        : undefined;
      try {
        response = await send(request);
      } finally {
        await body;
      }
    }
    call.httpStatus = response.status;
    if (!response.body) {
      call.complete = true;
      return response;
    }
    return observeResponse(response, response.body, call);
  };
}

function observeResponse(
  response: Response,
  body: ReadableStream<Uint8Array>,
  call: Exchange,
): Response {
  // Forward the original chunks with downstream backpressure. There is no second reader that
  // could run ahead of the SDK or keep a cancelled HTTP request alive.
  const reader = body.getReader();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            call.complete = true;
            controller.close();
          } else {
            call.chunks.push(Buffer.from(value));
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        cancelled = true;
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  const observed = new Response(stream, response);
  Object.defineProperties(observed, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return observed;
}
