import { MemoryConfig } from '@memory/memory.config';

describe('MemoryConfig', () => {
  const createConfig = (env: Record<string, string> = {}) => {
    const mockConfigService = { get: jest.fn((key: string, def?: string) => env[key] ?? def) };
    return new MemoryConfig(mockConfigService as never);
  };

  it('should use default values when env vars not set', () => {
    const config = createConfig();

    expect(config.sessionTtl).toBe(1 * 24 * 60 * 60); // 1d = 86400s
    expect(config.shortTermMaxMessages).toBe(60);
    expect(config.shortTermMaxChars).toBe(8000);
    expect(config.profileCacheTtl).toBe(2 * 60 * 60); // 2h
    expect(config.sessionTtlDays).toBe(1);
  });

  it('should read MEMORY_SESSION_TTL_DAYS from env', () => {
    const config = createConfig({ MEMORY_SESSION_TTL_DAYS: '3' });

    expect(config.sessionTtl).toBe(3 * 24 * 60 * 60); // 3d
    expect(config.sessionTtlDays).toBe(3);
  });

  it('should read MAX_HISTORY_PER_CHAT from env', () => {
    const config = createConfig({ MAX_HISTORY_PER_CHAT: '30' });

    expect(config.shortTermMaxMessages).toBe(30);
  });

  it('should read AGENT_MAX_INPUT_CHARS from env', () => {
    const config = createConfig({ AGENT_MAX_INPUT_CHARS: '16000' });

    expect(config.shortTermMaxChars).toBe(16000);
  });

  it('should keep profileCacheTtl hardcoded at 2h', () => {
    const config = createConfig({ MEMORY_SESSION_TTL_DAYS: '7' });

    expect(config.profileCacheTtl).toBe(7200);
  });
});
