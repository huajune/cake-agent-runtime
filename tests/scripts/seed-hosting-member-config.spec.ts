type SeedHelpers = {
  parseArgs(argv: string[]): { env: string; apply: boolean };
  resolveTokenValue(value: unknown): string | null;
  buildTokenResolver(
    config: unknown,
  ): (ctx: { botImId?: string; botUserId?: string; groupId?: string }) => string | null;
  redactTokens(config: unknown): unknown;
};

const helpers = jest.requireActual<SeedHelpers>('../../scripts/seed-hosting-member-config.js');

describe('seed-hosting-member-config helpers', () => {
  const originalEnv = process.env.SEED_TOKEN_FOR_TEST;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SEED_TOKEN_FOR_TEST;
    } else {
      process.env.SEED_TOKEN_FOR_TEST = originalEnv;
    }
  });

  it('parses dry-run/apply arguments with .env.local default', () => {
    expect(helpers.parseArgs([])).toEqual({ env: '.env.local', apply: false });
    expect(helpers.parseArgs(['--env', '.env.production', '--apply'])).toEqual({
      env: '.env.production',
      apply: true,
    });
  });

  it('resolves token values from literal token or tokenEnv', () => {
    process.env.SEED_TOKEN_FOR_TEST = ' env-token ';

    expect(helpers.resolveTokenValue(' literal-token ')).toBe('literal-token');
    expect(helpers.resolveTokenValue({ token: ' object-token ' })).toBe('object-token');
    expect(helpers.resolveTokenValue({ tokenEnv: 'SEED_TOKEN_FOR_TEST' })).toBe('env-token');
    expect(helpers.resolveTokenValue({ tokenEnv: 'MISSING_TOKEN_FOR_TEST' })).toBeNull();
  });

  it('builds account token resolver in the expected bot/group priority order', () => {
    const resolve = helpers.buildTokenResolver({
      accounts: [
        { botImId: 'bot-1', token: 'account-bot-token' },
        { botUserId: 'user-1', token: 'account-user-token' },
        { groupId: 'group-1', token: 'account-group-token' },
      ],
      byBotImId: { 'bot-1': 'mapped-bot-token', 'bot-2': 'mapped-bot-token-2' },
      byBotUserId: { 'user-2': 'mapped-user-token' },
      byGroupId: { 'group-2': 'mapped-group-token' },
    });

    expect(resolve({ botImId: 'bot-1', botUserId: 'user-1', groupId: 'group-1' })).toBe(
      'account-bot-token',
    );
    expect(resolve({ botImId: 'bot-2' })).toBe('mapped-bot-token-2');
    expect(resolve({ botUserId: 'user-2' })).toBe('mapped-user-token');
    expect(resolve({ groupId: 'group-2' })).toBe('mapped-group-token');
    expect(resolve({})).toBeNull();
  });

  it('redacts duliday tokens while preserving the last four characters', () => {
    expect(
      helpers.redactTokens({
        members: {
          'bot-1': { feishuName: '琪琪', dulidayToken: 'abcdef123456' },
        },
      }),
    ).toEqual({
      members: {
        'bot-1': { feishuName: '琪琪', dulidayToken: '***3456' },
      },
    });
  });
});

export {};
