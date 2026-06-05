type BackfillHelpers = {
  parseArgs(argv: string[]): {
    env: string;
    dryRun: boolean;
    limit: number | null;
    concurrency: number;
    corpId: string | null;
    userId: string | null;
    phoneMapFile: string | null;
    outFile?: string;
    targetEnv?: string;
  };
  maskPhone(phone: string): string;
  cnLocalToIso(value: string): string | null;
  dayKey(value: string | null | undefined): string | null;
  resolveTokenValue(value: unknown): string | null;
  buildTokenResolver(
    config: unknown,
    fallbackToken?: string | null,
  ): (botImId?: string) => string | null;
};

const helpers = jest.requireActual<BackfillHelpers>(
  '../../scripts/backfill-interview-passed-from-sponge.js',
);

describe('backfill-interview-passed-from-sponge helpers', () => {
  const originalEnv = process.env.BACKFILL_TOKEN_FOR_TEST;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BACKFILL_TOKEN_FOR_TEST;
    } else {
      process.env.BACKFILL_TOKEN_FOR_TEST = originalEnv;
    }
  });

  it('parses dry-run/apply and filtering arguments', () => {
    expect(helpers.parseArgs([])).toMatchObject({
      env: '.env.local',
      dryRun: true,
      limit: null,
      concurrency: 4,
    });
    expect(
      helpers.parseArgs([
        '--env',
        '.env.production',
        '--apply',
        '--limit',
        '10',
        '--concurrency',
        '2',
        '--corp-id',
        'corp-1',
        '--user-id',
        'user-1',
        '--phone-map',
        '/tmp/phones.json',
        '--out',
        '/tmp/out.json',
        '--target-env',
        '.env.local',
      ]),
    ).toMatchObject({
      env: '.env.production',
      dryRun: false,
      limit: 10,
      concurrency: 2,
      corpId: 'corp-1',
      userId: 'user-1',
      phoneMapFile: '/tmp/phones.json',
      outFile: '/tmp/out.json',
      targetEnv: '.env.local',
    });
  });

  it('normalizes Chinese local interview time and masks phone numbers', () => {
    expect(helpers.cnLocalToIso('2026-06-05 14:30:12')).toBe('2026-06-05T14:30:12+08:00');
    expect(helpers.cnLocalToIso('2026-06-05T14:30')).toBe('2026-06-05T14:30:00+08:00');
    expect(helpers.cnLocalToIso('bad-time')).toBeNull();
    expect(helpers.dayKey('2026-06-05 14:30:12')).toBe('2026-06-05');
    expect(helpers.dayKey(null)).toBeNull();
    expect(helpers.maskPhone('13800138000')).toBe('138****00');
  });

  it('resolves backfill sponge token by enabled account, map, default, then fallback', () => {
    process.env.BACKFILL_TOKEN_FOR_TEST = ' env-token ';
    const resolve = helpers.buildTokenResolver(
      {
        accounts: [
          { botImId: 'disabled-bot', token: 'disabled-token', enabled: false },
          { botImId: 'bot-1', tokenEnv: 'BACKFILL_TOKEN_FOR_TEST' },
        ],
        byBotImId: {
          'bot-2': { token: 'mapped-token' },
        },
        defaultToken: 'default-token',
      },
      'fallback-token',
    );

    expect(helpers.resolveTokenValue({ tokenEnv: 'BACKFILL_TOKEN_FOR_TEST' })).toBe('env-token');
    expect(resolve('bot-1')).toBe('env-token');
    expect(resolve('bot-2')).toBe('mapped-token');
    expect(resolve('disabled-bot')).toBe('default-token');
    expect(resolve('missing-bot')).toBe('default-token');
    expect(helpers.buildTokenResolver({}, 'fallback-token')('missing-bot')).toBe('fallback-token');
  });
});

export {};
