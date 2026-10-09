const {
  parseReview,
  publishReview,
  FALLBACK_PREFIX,
  LEGACY_FALLBACK_PREFIX,
} = require('../../scripts/ai-code-review');

const head = 'a'.repeat(40);
const approval = { decision: 'APPROVE', summary: 'No blocking findings.', blocking_findings: [] };
const rejection = {
  decision: 'REQUEST_CHANGES',
  summary: 'A security regression must be fixed.',
  blocking_findings: ['src/example.ts:12 exposes a credential in the HTTP response.'],
};
const context = { GITHUB_REPOSITORY: 'example/repo', PR_NUMBER: '42', HEAD_SHA: head };
const gptEnv = {
  ...context,
  AI_REVIEW_PROVIDER: 'gpt',
  GPT_OUTCOME: 'success',
  GPT_REVIEW_JSON: JSON.stringify(approval),
};

function fallback(id: number, commit = head, prefix = FALLBACK_PREFIX) {
  return {
    id,
    commit_id: commit,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
    body: `${prefix} ${commit}. Inspect the workflow run.`,
  };
}

function mockApi(previous: unknown[] = [], sha = head, state = 'open') {
  return jest.fn((method: string, endpoint: string) => {
    if (method !== 'GET') return {};
    if (endpoint.endsWith('/reviews?per_page=100')) return [previous];
    return { state, head: { sha } };
  });
}

describe('selected AI review output', () => {
  it('defaults to GPT and does not use a result from the inactive provider', () => {
    expect(parseReview({ ...gptEnv, AI_REVIEW_PROVIDER: undefined })).toEqual(approval);
    expect(
      parseReview({
        ...gptEnv,
        GPT_OUTCOME: 'failure',
        CLAUDE_OUTCOME: 'success',
        CLAUDE_REVIEW_JSON: JSON.stringify(approval),
      }),
    ).toBeNull();
  });

  it('switches to Claude and ignores GPT output', () => {
    expect(
      parseReview({
        ...gptEnv,
        AI_REVIEW_PROVIDER: 'claude',
        CLAUDE_OUTCOME: 'success',
        CLAUDE_REVIEW_JSON: JSON.stringify(rejection),
      }),
    ).toEqual(rejection);
  });

  it.each(['unknown', 'toString', 'GPT'])('fails closed for provider %s', (provider) => {
    expect(parseReview({ ...gptEnv, AI_REVIEW_PROVIDER: provider })).toBeNull();
  });

  it.each(['failure', 'cancelled', 'skipped', '', undefined])(
    'rejects output when the selected action outcome is %s',
    (outcome) => {
      expect(parseReview({ ...gptEnv, GPT_OUTCOME: outcome })).toBeNull();
    },
  );

  it.each(['', '{', 'null', '[]', '```json\n{}\n```'])('rejects invalid JSON %s', (raw) => {
    expect(parseReview({ ...gptEnv, GPT_REVIEW_JSON: raw })).toBeNull();
  });

  it.each([
    { ...approval, summary: '  \n' },
    { ...approval, summary: 'a'.repeat(4001) },
    { ...approval, summary: 1 },
    { ...approval, extra: true },
    { decision: 'APPROVE', blocking_findings: [] },
    { ...approval, decision: 'COMMENT' },
    { ...approval, blocking_findings: ['A critical problem'] },
    { ...rejection, blocking_findings: [] },
    { ...rejection, blocking_findings: ['  '] },
    { ...rejection, blocking_findings: [42] },
    { ...rejection, blocking_findings: [{ message: 'Bug' }] },
    { ...rejection, blocking_findings: 'Bug' },
    { ...rejection, blocking_findings: ['a'.repeat(1001)] },
    { ...rejection, blocking_findings: Array(21).fill('Bug') },
  ])('rejects inconsistent or out-of-contract results %#', (review) => {
    expect(parseReview({ ...gptEnv, GPT_REVIEW_JSON: JSON.stringify(review) })).toBeNull();
  });
});

describe('deterministic review publishing', () => {
  it('publishes a decision for the exact HEAD and keeps model text as data', () => {
    const summary = 'Review $(touch /tmp/pwned); `echo injected`\n"literal"';
    const api = mockApi();
    expect(
      publishReview({ ...gptEnv, GPT_REVIEW_JSON: JSON.stringify({ ...approval, summary }) }, api),
    ).toBe('APPROVE');
    expect(api).toHaveBeenCalledWith('POST', 'repos/example/repo/pulls/42/reviews', {
      event: 'APPROVE',
      commit_id: head,
      body: summary,
    });
  });

  it('publishes concrete blocking findings instead of treating a rejection as provider failure', () => {
    const api = mockApi();
    expect(publishReview({ ...gptEnv, GPT_REVIEW_JSON: JSON.stringify(rejection) }, api)).toBe(
      'REQUEST_CHANGES',
    );
    expect(api).toHaveBeenCalledWith('POST', 'repos/example/repo/pulls/42/reviews', {
      event: 'REQUEST_CHANGES',
      commit_id: head,
      body: `${rejection.summary}\n\nBlocking findings:\n- ${rejection.blocking_findings[0]}`,
    });
  });

  it('posts one failure placeholder and fails the job', () => {
    const api = mockApi();
    expect(() => publishReview({ ...gptEnv, GPT_OUTCOME: 'failure' }, api)).toThrow(
      'remains blocked',
    );
    expect(api).toHaveBeenCalledWith('POST', 'repos/example/repo/pulls/42/reviews', {
      event: 'REQUEST_CHANGES',
      commit_id: head,
      body: expect.stringContaining(FALLBACK_PREFIX),
    });
    expect(api.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(0);
  });

  it.each([FALLBACK_PREFIX, LEGACY_FALLBACK_PREFIX])(
    'does not duplicate an existing failure placeholder (%s)',
    (prefix) => {
      const api = mockApi([fallback(1, head, prefix)]);
      expect(() => publishReview({ ...gptEnv, GPT_REVIEW_JSON: '' }, api)).toThrow(
        'remains blocked',
      );
      expect(api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    },
  );

  it('only dismisses workflow failure placeholders after successfully publishing a decision', () => {
    const human = { ...fallback(3), user: { login: 'reviewer' } };
    const realFinding = { ...fallback(4), body: 'src/example.ts:12 exposes a credential.' };
    const dismissed = { ...fallback(5), state: 'DISMISSED' };
    const api = mockApi([
      fallback(1, 'b'.repeat(40)),
      fallback(2, head, LEGACY_FALLBACK_PREFIX),
      human,
      realFinding,
      dismissed,
    ]);
    publishReview(gptEnv, api);
    expect(api.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET', 'POST', 'PUT', 'PUT']);
    expect(api.mock.calls.filter(([method]) => method === 'PUT').map(([, url]) => url)).toEqual([
      'repos/example/repo/pulls/42/reviews/1/dismissals',
      'repos/example/repo/pulls/42/reviews/2/dismissals',
    ]);
  });

  it('does not dismiss blockers if submitting the real decision fails', () => {
    const api = mockApi([fallback(1)]);
    api.mockImplementation((method: string) => {
      if (method === 'POST') throw new Error('GitHub unavailable');
      return method === 'GET' && api.mock.calls.length === 1
        ? { state: 'open', head: { sha: head } }
        : [[fallback(1)]];
    });
    expect(() => publishReview(gptEnv, api)).toThrow('GitHub unavailable');
    expect(api.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it.each([
    ['b'.repeat(40), 'open'],
    [head, 'closed'],
  ])('does not publish stale or closed PR reviews', (sha, state) => {
    const api = mockApi([], sha, state);
    expect(() => publishReview(gptEnv, api)).toThrow('obsolete review');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it.each([
    { PR_NUMBER: '42; echo injected' },
    { HEAD_SHA: 'develop' },
    { GITHUB_REPOSITORY: '../evil/repo' },
  ])('rejects invalid PR context before any API request', (invalid) => {
    const api = mockApi();
    expect(() => publishReview({ ...gptEnv, ...invalid }, api)).toThrow('Invalid PR context');
    expect(api).not.toHaveBeenCalled();
  });
});
