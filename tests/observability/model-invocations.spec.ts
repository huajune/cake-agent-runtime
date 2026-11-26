import {
  captureProviderFetch,
  captureReplyGeneration,
  takeModelInvocations,
  withProcessingTurn,
} from '@observability/context/model-invocations';

const endpoint = 'https://models.invalid/chat?key=never-store-url';
const init = {
  method: 'POST',
  headers: { Authorization: 'never-store-header' },
  body: ' { "model": "fixture" }\n',
};

it('passes through an SSE response byte-for-byte including split UTF-8, unrecognized fields and DONE', async () => {
  const raw = Buffer.from('data: {"思考":"一下","vendor_only":1}\r\n\r\ndata: [DONE]\n\n');
  const send = jest.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(raw.subarray(0, 10));
            c.enqueue(raw.subarray(10));
            c.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const observed = captureProviderFetch('qwen', send);
  await withProcessingTurn('stream', async () => {
    await captureReplyGeneration(async () => {
      const response = await observed(endpoint, init);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(raw);
    });
    const calls = takeModelInvocations('stream')!;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      httpStatus: 200,
      complete: true,
      requestBody: Buffer.from(init.body).toString('base64'),
      responseBody: raw.toString('base64'),
    });
    expect(JSON.stringify(calls)).not.toContain('never-store');
    expect(send).toHaveBeenCalledWith(endpoint, init);
  });
});

it('isolates simultaneous turns, a transport failure before headers and untracked background requests', async () => {
  const err = new Error('disconnected');
  const observed = captureProviderFetch('deepseek', async () => {
    throw err;
  });
  await Promise.all(
    ['A', 'B'].map((id) =>
      withProcessingTurn(id, async () => {
        await expect(observed(endpoint, init)).rejects.toBe(err);
        await captureReplyGeneration(async () => {
          await expect(observed(new Request(endpoint, { ...init, body: id }))).rejects.toBe(err);
        });
        expect(takeModelInvocations(id === 'A' ? 'B' : 'A')).toBeUndefined();
        expect(takeModelInvocations(id)).toEqual([
          expect.objectContaining({
            httpStatus: null,
            complete: false,
            requestBody: Buffer.from(id).toString('base64'),
            responseBody: null,
          }),
        ]);
      }),
    ),
  );
});

it.each(['error', 'cancel'] as const)(
  'keeps the byte prefix on a stream %s, including a read pending at cancellation',
  async (ending) => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        source = c;
        c.enqueue(Uint8Array.from([0xff, 0]));
      },
      cancel,
    });
    const observed = captureProviderFetch('qwen', async () => new Response(body));
    await withProcessingTurn('partial', async () => {
      await captureReplyGeneration(async () => {
        const reader = (await observed(endpoint, init)).body!.getReader();
        await reader.read();
        const pending = reader.read();
        if (ending === 'cancel') {
          await reader.cancel('stop');
          expect(cancel).toHaveBeenCalledWith('stop');
          await pending;
        } else {
          source.error(new Error('body failed'));
          await expect(pending).rejects.toThrow('body failed');
        }
      });
      expect(takeModelInvocations('partial')).toEqual([
        expect.objectContaining({ complete: false, httpStatus: 200, responseBody: '/wA=' }),
      ]);
    });
  },
);
