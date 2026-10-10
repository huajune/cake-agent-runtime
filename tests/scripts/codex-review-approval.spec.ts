const bridge = require('../../scripts/codex-review-approval');

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-10T08:00:00Z');
const bot = { ...bridge.CODEX, type: 'Bot' };
const actions = { ...bridge.ACTIONS, type: 'Bot' };
function fixture() {
  return {
    pr: {
      state: 'open',
      draft: false,
      changed_files: 1,
      base: { ref: 'develop', repo: { full_name: 'owner/repo' } },
      head: { sha: HEAD, repo: { full_name: 'owner/repo' } },
    },
    files: [{ filename: 'src/example.ts', previous_filename: '' }],
    comments: [
      {
        id: 100,
        user: { ...bot },
        html_url: 'https://github.com/owner/repo/issues/1#issuecomment-100',
        body: `${bridge.SUMMARY}\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-10T07:59:01.123Z">time</relative-time> | \`aaaaaaa\` | New commits |`,
      },
    ],
    reactions: [{ id: 200, user: { ...bot }, content: '+1', created_at: '2026-10-10T07:59:02Z' }],
    reviews: [] as Array<{
      id: number;
      user: typeof bot;
      state: string;
      commit_id: string;
      body: string;
    }>,
    inlineComments: [] as Array<{
      user: typeof bot;
      original_commit_id: string;
      commit_id: string;
    }>,
  };
}

describe('official Codex approval evidence', () => {
  it('accepts fresh official no-findings evidence for the current head', () => {
    expect(bridge.assess(fixture(), NOW)).toMatchObject({
      eligible: true,
      head: HEAD,
      evidence: '100:1791619141123:200',
    });
  });
  it.each(['comments', 'reactions'] as const)(
    'rejects a spoofed %s author, even with the same login',
    (field) => {
      const state = fixture();
      state[field][0].user.id = 123;
      expect(bridge.assess(state, NOW).eligible).toBe(false);
    },
  );
  it('does not approve Completed without the official PR reaction', () => {
    const state = fixture();
    state.reactions = [];
    expect(bridge.assess(state, NOW).reason).toMatch(/No fresh/);
  });
  it('accepts the actual reactions API User type for the pinned official bot ID', () => {
    const state = fixture();
    state.reactions[0].user.type = 'User';
    expect(bridge.assess(state, NOW).eligible).toBe(true);
    state.reactions[0].user.id = 123;
    expect(bridge.assess(state, NOW).eligible).toBe(false);
  });
  it.each(['running', 'old-sha', 'future', 'unknown-format', 'missing-code', 'duplicate'])(
    'rejects %s summary',
    (kind) => {
      const state = fixture();
      if (kind === 'running')
        state.comments[0].body = state.comments[0].body.replace(
          '✅ **Completed**',
          '🔄 **Running** since',
        );
      if (kind === 'old-sha')
        state.comments[0].body = state.comments[0].body.replace('aaaaaaa', 'bbbbbbb');
      if (kind === 'future')
        state.comments[0].body = state.comments[0].body.replace('07:59:01', '08:01:00');
      if (kind === 'unknown-format')
        state.comments[0].body = state.comments[0].body.replace('✅ **Completed**', 'Success');
      if (kind === 'missing-code')
        state.comments[0].body = state.comments[0].body.replace('Code Review', 'Security Review');
      if (kind === 'duplicate') state.comments.push({ ...state.comments[0], id: 101 });
      expect(bridge.assess(state, NOW).eligible).toBe(false);
    },
  );
  it('requires every listed review, including security, to be completed', () => {
    const state = fixture();
    state.comments[0].body +=
      '\n| 🔐 **Security Review** | 🔄 **Running** | `aaaaaaa` | On request |';
    expect(bridge.assess(state, NOW).eligible).toBe(false);
  });
  it.each(['07:58:59', '08:01:00'])('rejects stale/future thumbs up at %s', (time) => {
    const state = fixture();
    state.reactions[0].created_at = `2026-10-10T${time}Z`;
    expect(bridge.assess(state, NOW).eligible).toBe(false);
  });
  it('allows the reaction in the completion second because GitHub truncates timestamp precision', () => {
    const state = fixture();
    state.reactions[0].created_at = '2026-10-10T07:59:01Z';
    expect(bridge.assess(state, NOW).eligible).toBe(true);
  });
  it('rejects thumbs up while official eyes indicate another review is active', () => {
    const state = fixture();
    state.reactions.push({ ...state.reactions[0], content: 'eyes', id: 201 });
    expect(bridge.assess(state, NOW).eligible).toBe(false);
  });
  it('rejects a current Codex finding even when a thumbs up exists', () => {
    const state = fixture();
    state.reviews.push({
      id: 1,
      user: bot,
      state: 'COMMENTED',
      commit_id: HEAD,
      body: 'Review suggestions',
    });
    expect(bridge.assess(state, NOW).reason).toMatch(/reported findings/);
  });
  it('uses original_commit_id for inline findings; GitHub rebases commit_id on later pushes', () => {
    const state = fixture();
    state.inlineComments.push({ user: bot, original_commit_id: 'b'.repeat(40), commit_id: HEAD });
    expect(bridge.assess(state, NOW).eligible).toBe(true);
    state.inlineComments[0].original_commit_id = HEAD;
    expect(bridge.assess(state, NOW).eligible).toBe(false);
  });
  it('preserves a human request for changes despite a later comment', () => {
    const state = fixture();
    state.reviews.push({
      id: 1,
      user: { id: 1, login: 'reviewer', type: 'User' },
      state: 'CHANGES_REQUESTED',
      commit_id: 'old',
      body: 'Fix bug',
    });
    state.reviews.push({ ...state.reviews[0], id: 2, state: 'COMMENTED' });
    expect(bridge.assess(state, NOW).eligible).toBe(false);
    state.reviews.push({ ...state.reviews[0], id: 3, state: 'APPROVED' });
    expect(bridge.assess(state, NOW).eligible).toBe(true);
  });
  it.each([
    '.github/workflows/anything.yml',
    'scripts/codex-review-approval.js',
    'tests/scripts/codex-review-approval.spec.ts',
  ])('requires independent approval for authority changes: %s', (filename) => {
    const state = fixture();
    state.files[0].filename = filename;
    expect(bridge.assess(state, NOW).eligible).toBe(false);
    state.files[0] = { filename: 'renamed.js', previous_filename: filename };
    expect(bridge.assess(state, NOW).eligible).toBe(false);
  });
  it.each(['draft', 'closed', 'fork', 'base', 'truncated-files'])('rejects %s PR', (kind) => {
    const state = fixture();
    if (kind === 'draft') state.pr.draft = true;
    if (kind === 'closed') state.pr.state = 'closed';
    if (kind === 'fork') state.pr.head.repo.full_name = 'other/repo';
    if (kind === 'base') state.pr.base.ref = 'master';
    if (kind === 'truncated-files') state.pr.changed_files = 101;
    expect(bridge.assess(state, NOW).eligible).toBe(false);
  });
});

describe('approval writes and races', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  function harness() {
    const state = fixture();
    const api = jest.fn(async (path: string, method: string, body: Record<string, string>) => {
      if (method === 'POST') {
        state.reviews.push({
          id: 300,
          user: actions,
          state: 'APPROVED',
          commit_id: body.commit_id,
          body: body.body,
        });
      } else if (method === 'PUT') {
        const id = Number(path.split('/').at(-2));
        const review = state.reviews.find((item) => item.id === id);
        if (review) review.state = 'DISMISSED';
      }
      return state.reviews.at(-1) || {};
    });
    return { state, api, number: 1, apply: true, read: async () => structuredClone(state) };
  }
  it('writes APPROVE once with exact HEAD and is idempotent on repeated events', async () => {
    const input = harness();
    expect(await bridge.synchronize(input)).toMatchObject({ approved: true });
    expect(await bridge.synchronize(input)).toMatchObject({ approved: true });
    expect(input.api).toHaveBeenCalledTimes(1);
    expect(input.api).toHaveBeenCalledWith(
      'pulls/1/reviews',
      'POST',
      expect.objectContaining({ event: 'APPROVE', commit_id: HEAD }),
    );
  });
  it('dry run never writes or dismisses', async () => {
    const input = harness();
    await bridge.synchronize({ ...input, apply: false });
    expect(input.api).not.toHaveBeenCalled();
  });
  it('dismisses only its own stale approval when a new head or running review arrives', async () => {
    const input = harness();
    await bridge.synchronize(input);
    input.api.mockClear();
    input.state.reviews.push({
      ...input.state.reviews[0],
      id: 400,
      body: 'Independent human approval',
      user: { id: 1, login: 'reviewer', type: 'User' },
    });
    input.state.pr.head.sha = 'b'.repeat(40);
    expect((await bridge.synchronize(input)).eligible).toBe(false);
    expect(input.api).toHaveBeenCalledTimes(1);
    expect(input.api.mock.calls[0][0]).toBe('pulls/1/reviews/300/dismissals');
  });
  it('does not approve if the head changes during evidence reads', async () => {
    const input = harness();
    let reads = 0;
    input.read = async () => {
      if (++reads === 2) input.state.pr.head.sha = 'b'.repeat(40);
      return structuredClone(input.state);
    };
    expect((await bridge.synchronize(input)).eligible).toBe(false);
    expect(input.api).not.toHaveBeenCalled();
  });
  it('withdraws the new approval if evidence changes while submitting it', async () => {
    const input = harness();
    let reads = 0;
    input.read = async () => {
      if (++reads === 3) input.state.reactions = [];
      return structuredClone(input.state);
    };
    expect((await bridge.synchronize(input)).reason).toMatch(/dismissed/);
    expect(input.api.mock.calls.map((call) => call[1])).toEqual(['POST', 'PUT']);
    expect(input.state.reviews[0].state).toBe('DISMISSED');
  });
  it('only clears old Claude infrastructure failures after verified approval', async () => {
    const input = harness();
    input.state.reviews.push({
      id: 9,
      user: actions,
      state: 'CHANGES_REQUESTED',
      commit_id: 'b'.repeat(40),
      body: `Automated AI review did not produce a valid structured decision for HEAD ${'b'.repeat(40)}. Inspect the workflow run.`,
    });
    expect(await bridge.synchronize(input)).toMatchObject({ approved: true });
    expect(input.api.mock.calls.map((call) => call[1])).toEqual(['POST', 'PUT']);
    expect(input.state.reviews[0].state).toBe('DISMISSED');
  });
  it('does not clear legacy failures if the latest native review has findings', async () => {
    const input = harness();
    input.state.reactions = [];
    input.state.reviews.push({
      id: 9,
      user: actions,
      state: 'CHANGES_REQUESTED',
      commit_id: HEAD,
      body: `Automated AI review did not produce a valid structured decision for HEAD ${HEAD}. Inspect the workflow run.`,
    });
    await bridge.synchronize(input);
    expect(input.api).not.toHaveBeenCalled();
  });
  it('fails on API errors rather than approving with partial evidence', async () => {
    const input = harness();
    input.read = async () => {
      throw new Error('HTTP 403');
    };
    await expect(bridge.synchronize(input)).rejects.toThrow('HTTP 403');
    expect(input.api).not.toHaveBeenCalled();
  });
  it('withdraws approval when its post-write validation API fails', async () => {
    const input = harness();
    let reads = 0;
    input.read = async () => {
      if (++reads === 3) throw new Error('HTTP 502');
      return structuredClone(input.state);
    };
    await expect(bridge.synchronize(input)).rejects.toThrow('HTTP 502');
    expect(input.api.mock.calls.map((call) => call[1])).toEqual(['POST', 'PUT']);
    expect(input.state.reviews[0].state).toBe('DISMISSED');
  });
  it('loads all pages, including a finding after the first 100 rows', async () => {
    const api = jest
      .fn()
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, id) => ({ id })))
      .mockResolvedValueOnce([{ id: 101, body: 'finding' }]);
    expect(await bridge.list(api, 'pulls/1/reviews')).toHaveLength(101);
    expect(api.mock.calls[1][0]).toContain('page=2');
  });
});
